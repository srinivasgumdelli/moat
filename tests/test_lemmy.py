"""Tests for the Lemmy REST API ingest source."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.lemmy import LemmySource

MOCK_LEMMY_RESPONSE = {
    "posts": [
        {
            "post": {
                "name": "New open source AI model released",
                "url": "https://example.com/ai-model",
                "body": "Check out this new model",
                "ap_id": "https://lemmy.world/post/12345",
                "published": "2024-01-15T12:00:00Z",
            },
        },
        {
            "post": {
                "name": "Discussion: Linux kernel 7.0 features",
                "url": "",
                "body": "What features are you most excited about?",
                "ap_id": "https://lemmy.world/post/12346",
                "published": "2024-01-15T13:00:00Z",
            },
        },
    ],
}


@pytest.fixture
def lemmy_config():
    return {
        "sources": {
            "lemmy": {
                "enabled": True,
                "instance_url": "https://lemmy.world",
                "limit": 15,
                "communities": {
                    "tech": ["technology"],
                },
            }
        }
    }


@pytest.mark.asyncio
@patch("intel.ingest.lemmy.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.lemmy.LemmySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_lemmy_fetches_articles(mock_fetch, mock_extract, lemmy_config):
    """Lemmy source parses API response into Article objects."""
    mock_fetch.return_value = MOCK_LEMMY_RESPONSE
    mock_extract.return_value = "Extracted article content"

    source = LemmySource(lemmy_config)
    articles = await source.fetch("tech")

    assert len(articles) == 2

    assert articles[0].title == "New open source AI model released"
    assert articles[0].url == "https://example.com/ai-model"
    assert articles[0].source_type == "lemmy"
    assert articles[0].source_name == "c/technology"
    assert articles[0].topic == "tech"
    assert articles[0].content == "Extracted article content"
    assert articles[0].published_at is not None

    # Post without external URL falls back to ap_id
    assert articles[1].url == "https://lemmy.world/post/12346"


@pytest.mark.asyncio
@patch(
    "intel.ingest.lemmy.LemmySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_lemmy_empty_topic(mock_fetch, lemmy_config):
    """Lemmy returns empty list for unconfigured topic."""
    source = LemmySource(lemmy_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch(
    "intel.ingest.lemmy.LemmySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_lemmy_disabled(mock_fetch):
    """When enabled is false, returns empty list without fetching."""
    config = {
        "sources": {
            "lemmy": {
                "enabled": False,
                "communities": {"tech": ["technology"]},
            }
        }
    }

    source = LemmySource(config)
    articles = await source.fetch("tech")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.lemmy.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.lemmy.LemmySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_lemmy_api_failure_returns_empty(
    mock_fetch, mock_extract, lemmy_config,
):
    """When Lemmy API fails, returns empty list with warning."""
    mock_fetch.side_effect = Exception("Connection refused")

    source = LemmySource(lemmy_config)
    articles = await source.fetch("tech")

    assert articles == []
