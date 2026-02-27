"""Tests for the Reddit ingest source."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.reddit import RedditSource


@pytest.fixture
def reddit_config():
    return {
        "sources": {
            "reddit": {
                "enabled": True,
                "client_id": "test-id",
                "client_secret": "test-secret",
                "limit": 15,
                "min_score": 10,
                "subreddits": {
                    "tech": ["technology"],
                },
            }
        }
    }


@pytest.fixture
def mock_reddit_json():
    """Mock Reddit JSON API response with two posts."""
    return {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "New AI Chip Announced",
                        "url": "https://example.com/ai-chip",
                        "permalink": "/r/technology/comments/abc123/ai/",
                        "score": 150,
                        "stickied": False,
                        "is_self": False,
                        "selftext": "",
                        "created_utc": 1700000000.0,
                    }
                },
                {
                    "data": {
                        "title": "Open Source Framework Released",
                        "url": "https://example.com/framework",
                        "permalink": "/r/technology/comments/def456/fw/",
                        "score": 85,
                        "stickied": False,
                        "is_self": False,
                        "selftext": "",
                        "created_utc": 1700001000.0,
                    }
                },
            ]
        }
    }


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_json", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_fetches_articles(
    mock_token, mock_fetch, mock_extract,
    reddit_config, mock_reddit_json,
):
    """Reddit source parses JSON response into Article objects."""
    mock_token.return_value = "fake-token"
    mock_fetch.return_value = mock_reddit_json
    mock_extract.return_value = "Extracted article content"

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 2

    assert articles[0].title == "New AI Chip Announced"
    assert articles[0].url == "https://example.com/ai-chip"
    assert articles[0].source_type == "reddit"
    assert articles[0].source_name == "r/technology"
    assert articles[0].topic == "tech"
    assert articles[0].content == "Extracted article content"
    assert articles[0].published_at == datetime.fromtimestamp(1700000000.0)

    assert articles[1].title == "Open Source Framework Released"
    assert articles[1].url == "https://example.com/framework"


@pytest.mark.asyncio
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_empty_topic(mock_token, reddit_config):
    """Reddit returns empty list for unconfigured topic."""
    mock_token.return_value = "fake-token"

    source = RedditSource(reddit_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    # Token not even requested for empty subreddit list
    mock_token.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_json", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_filters_stickied(
    mock_token, mock_fetch, mock_extract, reddit_config,
):
    """Stickied posts are filtered out of the results."""
    mock_token.return_value = "fake-token"
    mock_fetch.return_value = {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "Welcome to r/technology!",
                        "url": "https://www.reddit.com/r/technology/sticky",
                        "permalink": "/r/technology/comments/sticky/",
                        "score": 500,
                        "stickied": True,
                        "is_self": True,
                        "selftext": "Welcome post content",
                        "created_utc": 1700000000.0,
                    }
                },
                {
                    "data": {
                        "title": "Regular Post",
                        "url": "https://example.com/regular",
                        "permalink": "/r/technology/comments/xyz789/",
                        "score": 100,
                        "stickied": False,
                        "is_self": False,
                        "selftext": "",
                        "created_utc": 1700001000.0,
                    }
                },
            ]
        }
    }
    mock_extract.return_value = None

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 1
    assert articles[0].title == "Regular Post"


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_json", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_filters_low_score(
    mock_token, mock_fetch, mock_extract, reddit_config,
):
    """Posts below min_score are filtered out."""
    mock_token.return_value = "fake-token"
    mock_fetch.return_value = {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "Low Score Post",
                        "url": "https://example.com/low-score",
                        "permalink": "/r/technology/comments/low1/",
                        "score": 3,
                        "stickied": False,
                        "is_self": False,
                        "selftext": "",
                        "created_utc": 1700000000.0,
                    }
                },
                {
                    "data": {
                        "title": "High Score Post",
                        "url": "https://example.com/high-score",
                        "permalink": "/r/technology/comments/high1/",
                        "score": 200,
                        "stickied": False,
                        "is_self": False,
                        "selftext": "",
                        "created_utc": 1700001000.0,
                    }
                },
            ]
        }
    }
    mock_extract.return_value = None

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 1
    assert articles[0].title == "High Score Post"


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_json", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_self_post_content(
    mock_token, mock_fetch, mock_extract, reddit_config,
):
    """Self-posts use selftext as content and permalink as URL."""
    mock_token.return_value = "fake-token"
    mock_fetch.return_value = {
        "data": {
            "children": [
                {
                    "data": {
                        "title": "Discussion: Future of AI",
                        "url": "https://www.reddit.com/r/technology/self1",
                        "permalink": "/r/technology/comments/self1/ai/",
                        "score": 250,
                        "stickied": False,
                        "is_self": True,
                        "selftext": "What do you think about the future?",
                        "created_utc": 1700000000.0,
                    }
                },
            ]
        }
    }
    mock_extract.return_value = None

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 1
    assert articles[0].content == "What do you think about the future?"
    assert "/r/technology/comments/self1/" in articles[0].url
    # extract_content should NOT be called for self-posts
    mock_extract.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.RedditSource._fetch_json", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._get_token", new_callable=AsyncMock)
async def test_reddit_disabled(mock_token, mock_fetch):
    """When enabled is false, returns empty list without fetching."""
    config = {
        "sources": {
            "reddit": {
                "enabled": False,
                "client_id": "test-id",
                "client_secret": "test-secret",
                "subreddits": {"tech": ["technology"]},
            }
        }
    }

    source = RedditSource(config)
    articles = await source.fetch("tech")

    assert articles == []
    mock_token.assert_not_called()
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
async def test_reddit_missing_credentials():
    """Missing client_id/client_secret returns empty list."""
    config = {
        "sources": {
            "reddit": {
                "enabled": True,
                "subreddits": {"tech": ["technology"]},
            }
        }
    }

    source = RedditSource(config)
    articles = await source.fetch("tech")

    assert articles == []
