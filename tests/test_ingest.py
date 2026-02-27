"""Tests for ingest sources."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.rss import RSSSource


class FakeEntry(dict):
    """Dict subclass that also supports attribute access (like feedparser)."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


@pytest.fixture
def rss_config():
    return {
        "sources": {
            "rss": {
                "enabled": True,
                "feeds": {
                    "tech": [
                        {
                            "url": "https://example.com/feed.xml",
                            "name": "Test Feed",
                        }
                    ],
                },
            }
        }
    }


@pytest.fixture
def mock_feed_data():
    """Mock feedparser result."""
    entry1 = {
        "title": "AI Chip Startup Raises $500M",
        "link": "https://example.com/ai-chip",
        "summary": "A startup raised $500M for AI chips.",
    }
    entry2 = {
        "title": "Open Source LLM Matches Commercial Models",
        "link": "https://example.com/open-source-llm",
        "summary": (
            "An open-source language model has matched the "
            "performance of leading commercial models on "
            "major benchmarks, potentially disrupting the "
            "AI industry with wide-reaching implications "
            "for research and commercial use."
        ),
    }
    feed = type("Feed", (), {
        "entries": [FakeEntry(entry1), FakeEntry(entry2)],
    })()
    return feed


@pytest.mark.asyncio
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.rss.feedparser")
async def test_rss_fetches_articles(
    mock_fp, mock_extract, rss_config, mock_feed_data,
):
    """RSS source parses feed entries into Article objects."""
    mock_fp.parse.return_value = mock_feed_data
    mock_extract.return_value = None  # No full content extraction

    source = RSSSource(rss_config)
    articles = await source.fetch("tech")

    assert len(articles) == 2
    assert articles[0].title == "AI Chip Startup Raises $500M"
    assert articles[0].source_type == "rss"
    assert articles[0].topic == "tech"
    assert articles[0].source_name == "Test Feed"


@pytest.mark.asyncio
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.rss.feedparser")
async def test_rss_empty_topic(mock_fp, mock_extract, rss_config):
    """RSS returns empty list for unconfigured topic."""
    source = RSSSource(rss_config)
    articles = await source.fetch("geopolitics")
    assert articles == []
    mock_fp.parse.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.rss.feedparser")
async def test_rss_skips_entries_without_link(
    mock_fp, mock_extract, rss_config,
):
    """Entries missing link or title are skipped."""
    entry_no_link = FakeEntry(
        title="Has Title", link="", summary="content",
    )
    entry_no_title = FakeEntry(
        title="", link="https://example.com", summary="content",
    )
    feed = type("Feed", (), {"entries": [entry_no_link, entry_no_title]})()
    mock_fp.parse.return_value = feed

    source = RSSSource(rss_config)
    articles = await source.fetch("tech")
    assert len(articles) == 0
