"""Tests for the Reddit RSS ingest source."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.reddit import RedditSource

MOCK_RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>r/technology: hot</title>
<item>
<title>New AI Chip Announced by Startup</title>
<link>https://example.com/ai-chip</link>
<pubDate>Tue, 14 Nov 2023 12:00:00 +0000</pubDate>
</item>
<item>
<title>Open Source Framework Released</title>
<link>https://example.com/framework</link>
<pubDate>Tue, 14 Nov 2023 13:00:00 +0000</pubDate>
</item>
</channel>
</rss>"""

MOCK_RSS_SELF_POST = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>r/technology: hot</title>
<item>
<title>Discussion: Future of AI</title>
<link>https://www.reddit.com/r/technology/comments/self1/ai/</link>
<summary>What do you think about the future of AI?</summary>
<pubDate>Tue, 14 Nov 2023 12:00:00 +0000</pubDate>
</item>
</channel>
</rss>"""


@pytest.fixture
def reddit_config():
    return {
        "sources": {
            "reddit": {
                "enabled": True,
                "limit": 15,
                "subreddits": {
                    "tech": ["technology"],
                },
            }
        }
    }


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_fetches_articles(
    mock_fetch, mock_extract, reddit_config,
):
    """Reddit source parses RSS feed into Article objects."""
    mock_fetch.return_value = MOCK_RSS
    mock_extract.return_value = "Extracted article content"

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 2

    assert articles[0].title == "New AI Chip Announced by Startup"
    assert articles[0].url == "https://example.com/ai-chip"
    assert articles[0].source_type == "reddit"
    assert articles[0].source_name == "r/technology"
    assert articles[0].topic == "tech"
    assert articles[0].content == "Extracted article content"
    assert articles[0].published_at is not None

    assert articles[1].title == "Open Source Framework Released"


@pytest.mark.asyncio
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_empty_topic(mock_fetch, reddit_config):
    """Reddit returns empty list for unconfigured topic."""
    source = RedditSource(reddit_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_self_post_uses_summary(
    mock_fetch, mock_extract, reddit_config,
):
    """Self-posts (reddit.com links) use summary as content."""
    mock_fetch.return_value = MOCK_RSS_SELF_POST
    mock_extract.return_value = None

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert len(articles) == 1
    assert articles[0].title == "Discussion: Future of AI"
    assert "reddit.com" in articles[0].url
    assert articles[0].content == "What do you think about the future of AI?"
    # extract_content not called for reddit.com links
    mock_extract.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_external_link_extracts_content(
    mock_fetch, mock_extract, reddit_config,
):
    """External links trigger extract_content for full article text."""
    mock_fetch.return_value = MOCK_RSS
    mock_extract.return_value = "Full article text from website"

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert articles[0].content == "Full article text from website"
    mock_extract.assert_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_disabled(mock_fetch):
    """When enabled is false, returns empty list without fetching."""
    config = {
        "sources": {
            "reddit": {
                "enabled": False,
                "subreddits": {"tech": ["technology"]},
            }
        }
    }

    source = RedditSource(config)
    articles = await source.fetch("tech")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.reddit.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.reddit.RedditSource._fetch_rss", new_callable=AsyncMock)
async def test_reddit_feed_down_returns_empty(
    mock_fetch, mock_extract, reddit_config,
):
    """When old.reddit.com is unreachable, returns empty with warning."""
    mock_fetch.side_effect = Exception("Connection refused")

    source = RedditSource(reddit_config)
    articles = await source.fetch("tech")

    assert articles == []
