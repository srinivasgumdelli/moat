"""Tests for the Hacker News Algolia ingest source."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.hackernews import HackerNewsSource

MOCK_ALGOLIA_RESPONSE = {
    "hits": [
        {
            "objectID": "12345",
            "title": "Show HN: New AI Framework",
            "url": "https://example.com/ai-framework",
            "author": "pg",
            "points": 150,
            "created_at_i": 1700000000,
        },
        {
            "objectID": "12346",
            "title": "Ask HN: Best practices for LLM deployment?",
            "url": "",
            "author": "dang",
            "points": 42,
            "created_at_i": 1700001000,
        },
        {
            "objectID": "12347",
            "title": "Low quality post",
            "url": "https://example.com/low",
            "author": "newbie",
            "points": 3,
            "created_at_i": 1700002000,
        },
    ],
}


@pytest.fixture
def hn_config():
    return {
        "sources": {
            "hackernews": {
                "enabled": True,
                "min_points": 10,
                "limit": 15,
                "queries": {
                    "tech": ["artificial intelligence"],
                },
            }
        }
    }


@pytest.mark.asyncio
@patch("intel.ingest.hackernews.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.hackernews.HackerNewsSource._fetch_api",
    new_callable=AsyncMock,
)
async def test_hn_fetches_articles(mock_fetch, mock_extract, hn_config):
    """HN source parses Algolia response into Article objects."""
    mock_fetch.return_value = MOCK_ALGOLIA_RESPONSE
    mock_extract.return_value = "Extracted article content"

    source = HackerNewsSource(hn_config)
    articles = await source.fetch("tech")

    # Only 2 articles — third is below min_points threshold
    assert len(articles) == 2

    assert articles[0].title == "Show HN: New AI Framework"
    assert articles[0].url == "https://example.com/ai-framework"
    assert articles[0].source_type == "hackernews"
    assert articles[0].source_name == "HN/pg"
    assert articles[0].topic == "tech"
    assert articles[0].published_at is not None

    # Ask HN post with no URL gets constructed HN link
    assert articles[1].title == "Ask HN: Best practices for LLM deployment?"
    assert "news.ycombinator.com/item?id=12346" in articles[1].url


@pytest.mark.asyncio
@patch(
    "intel.ingest.hackernews.HackerNewsSource._fetch_api",
    new_callable=AsyncMock,
)
async def test_hn_empty_topic(mock_fetch, hn_config):
    """HN returns empty list for unconfigured topic."""
    source = HackerNewsSource(hn_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch(
    "intel.ingest.hackernews.HackerNewsSource._fetch_api",
    new_callable=AsyncMock,
)
async def test_hn_disabled(mock_fetch):
    """When enabled is false, returns empty list without fetching."""
    config = {
        "sources": {
            "hackernews": {
                "enabled": False,
                "queries": {"tech": ["AI"]},
            }
        }
    }

    source = HackerNewsSource(config)
    articles = await source.fetch("tech")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.hackernews.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.hackernews.HackerNewsSource._fetch_api",
    new_callable=AsyncMock,
)
async def test_hn_api_failure_returns_empty(
    mock_fetch, mock_extract, hn_config,
):
    """When Algolia API fails, returns empty list with warning."""
    mock_fetch.side_effect = Exception("Connection refused")

    source = HackerNewsSource(hn_config)
    articles = await source.fetch("tech")

    assert articles == []
