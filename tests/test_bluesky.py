"""Tests for the Bluesky AT Protocol ingest source."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.bluesky import BlueskySource, _at_uri_to_web_url

MOCK_BSKY_RESPONSE = {
    "posts": [
        {
            "uri": "at://did:plc:abc123/app.bsky.feed.post/xyz789",
            "author": {
                "handle": "alice.bsky.social",
                "displayName": "Alice",
            },
            "record": {
                "text": (
                    "Just published a new paper on transformer"
                    " architectures for edge devices."
                    " Results are promising!"
                ),
                "createdAt": "2024-01-15T12:00:00Z",
            },
            "embed": {
                "external": {
                    "uri": "https://example.com/paper",
                    "title": "Edge Transformers",
                },
            },
        },
        {
            "uri": "at://did:plc:def456/app.bsky.feed.post/abc123",
            "author": {
                "handle": "bob.bsky.social",
                "displayName": "Bob",
            },
            "record": {
                "text": "Short take on AI safety",
                "createdAt": "2024-01-15T13:00:00Z",
            },
            "embed": None,
        },
    ],
}


@pytest.fixture
def bluesky_config():
    return {
        "sources": {
            "bluesky": {
                "enabled": True,
                "limit": 15,
                "queries": {
                    "tech": ["artificial intelligence"],
                },
            }
        }
    }


def test_at_uri_to_web_url():
    """AT URI is correctly converted to bsky.app web URL."""
    uri = "at://did:plc:abc123/app.bsky.feed.post/xyz789"
    assert _at_uri_to_web_url(uri) == (
        "https://bsky.app/profile/did:plc:abc123/post/xyz789"
    )


def test_at_uri_to_web_url_passthrough():
    """Non-matching URIs are returned as-is."""
    uri = "https://example.com/something"
    assert _at_uri_to_web_url(uri) == uri


@pytest.mark.asyncio
@patch("intel.ingest.bluesky.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.bluesky.BlueskySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_bluesky_fetches_articles(
    mock_fetch, mock_extract, bluesky_config,
):
    """Bluesky source parses API response into Article objects."""
    mock_fetch.return_value = MOCK_BSKY_RESPONSE
    mock_extract.return_value = "Extracted paper content"

    source = BlueskySource(bluesky_config)
    articles = await source.fetch("tech")

    assert len(articles) == 2

    assert articles[0].title.startswith("@alice.bsky.social:")
    assert articles[0].url == (
        "https://bsky.app/profile/did:plc:abc123/post/xyz789"
    )
    assert articles[0].source_type == "bluesky"
    assert articles[0].source_name == "@alice.bsky.social"
    assert articles[0].topic == "tech"
    # Embed link was extracted
    assert "Extracted paper content" in articles[0].content
    assert articles[0].published_at is not None

    assert articles[1].source_name == "@bob.bsky.social"


@pytest.mark.asyncio
@patch(
    "intel.ingest.bluesky.BlueskySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_bluesky_empty_topic(mock_fetch, bluesky_config):
    """Bluesky returns empty list for unconfigured topic."""
    source = BlueskySource(bluesky_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch(
    "intel.ingest.bluesky.BlueskySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_bluesky_disabled(mock_fetch):
    """When enabled is false, returns empty list without fetching."""
    config = {
        "sources": {
            "bluesky": {
                "enabled": False,
                "queries": {"tech": ["AI"]},
            }
        }
    }

    source = BlueskySource(config)
    articles = await source.fetch("tech")

    assert articles == []
    mock_fetch.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.bluesky.extract_content", new_callable=AsyncMock)
@patch(
    "intel.ingest.bluesky.BlueskySource._fetch_api",
    new_callable=AsyncMock,
)
async def test_bluesky_api_failure_returns_empty(
    mock_fetch, mock_extract, bluesky_config,
):
    """When Bluesky API fails, returns empty list with warning."""
    mock_fetch.side_effect = Exception("Connection refused")

    source = BlueskySource(bluesky_config)
    articles = await source.fetch("tech")

    assert articles == []
