"""Tests for the X.com (Nitter) ingest source."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.ingest.xcom import XSource

MOCK_RSS = '''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>@testuser</title>
<item>
<title>This is a test tweet about AI breakthroughs</title>
<link>https://x.com/testuser/status/123456</link>
<pubDate>Thu, 14 Nov 2024 12:00:00 +0000</pubDate>
<author>@testuser</author>
</item>
</channel>
</rss>'''

MOCK_RSS_SEARCH = '''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>Search: AI breakthrough</title>
<item>
<title>Breaking: major AI breakthrough announced today</title>
<link>https://x.com/researcher/status/654321</link>
<pubDate>Thu, 14 Nov 2024 14:00:00 +0000</pubDate>
<author>@researcher</author>
</item>
</channel>
</rss>'''

MOCK_RSS_WITH_LINK = '''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>@techuser</title>
<item>
<title>Check out this article https://example.com/article about AI</title>
<link>https://x.com/techuser/status/789</link>
<author>@techuser</author>
</item>
</channel>
</rss>'''

INSTANCE = "https://xcancel.com"


@pytest.fixture
def xcom_config():
    return {
        "sources": {
            "xcom": {
                "enabled": True,
                "instance_url": INSTANCE,
                "accounts": {
                    "tech": ["testuser"],
                },
                "queries": {
                    "tech": ["AI breakthrough"],
                },
            }
        }
    }


@pytest.fixture
def xcom_config_disabled():
    return {
        "sources": {
            "xcom": {
                "enabled": False,
                "instance_url": INSTANCE,
                "accounts": {
                    "tech": ["testuser"],
                },
            }
        }
    }


@pytest.mark.asyncio
@patch("intel.ingest.xcom.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.xcom.XSource._fetch_feed_xml", new_callable=AsyncMock)
@patch(
    "intel.ingest.xcom.XSource._find_working_instance",
    new_callable=AsyncMock,
    return_value=INSTANCE,
)
async def test_xcom_fetches_from_accounts(
    mock_instance, mock_fetch_xml, mock_extract, xcom_config,
):
    """Account RSS feed is parsed into Article objects."""
    mock_fetch_xml.side_effect = [MOCK_RSS, MOCK_RSS_SEARCH]
    mock_extract.return_value = None

    source = XSource(xcom_config)
    articles = await source.fetch("tech")

    account_articles = [
        a for a in articles
        if a.url == "https://x.com/testuser/status/123456"
    ]
    assert len(account_articles) == 1

    art = account_articles[0]
    assert art.source_type == "xcom"
    assert art.topic == "tech"
    assert "@testuser" in art.title
    assert "AI breakthroughs" in art.title
    assert art.source_name == "@testuser"
    assert art.published_at is not None


@pytest.mark.asyncio
@patch("intel.ingest.xcom.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.xcom.XSource._fetch_feed_xml", new_callable=AsyncMock)
@patch(
    "intel.ingest.xcom.XSource._find_working_instance",
    new_callable=AsyncMock,
    return_value=INSTANCE,
)
async def test_xcom_fetches_from_search(
    mock_instance, mock_fetch_xml, mock_extract, xcom_config,
):
    """Search query RSS feed is parsed into Article objects."""
    mock_fetch_xml.side_effect = [MOCK_RSS, MOCK_RSS_SEARCH]
    mock_extract.return_value = None

    source = XSource(xcom_config)
    articles = await source.fetch("tech")

    search_articles = [
        a for a in articles
        if a.url == "https://x.com/researcher/status/654321"
    ]
    assert len(search_articles) == 1

    art = search_articles[0]
    assert art.source_type == "xcom"
    assert art.topic == "tech"
    assert "AI breakthrough" in art.title
    assert art.source_name == "@researcher"


@pytest.mark.asyncio
@patch("intel.ingest.xcom.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.xcom.XSource._fetch_feed_xml", new_callable=AsyncMock)
@patch(
    "intel.ingest.xcom.XSource._find_working_instance",
    new_callable=AsyncMock,
    return_value=INSTANCE,
)
async def test_xcom_empty_topic(
    mock_instance, mock_fetch_xml, mock_extract, xcom_config,
):
    """Unconfigured topic returns empty list without fetching."""
    source = XSource(xcom_config)
    articles = await source.fetch("geopolitics")

    assert articles == []
    mock_fetch_xml.assert_not_called()


@pytest.mark.asyncio
@patch("intel.ingest.xcom.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.xcom.XSource._fetch_feed_xml", new_callable=AsyncMock)
async def test_xcom_disabled(
    mock_fetch_xml, mock_extract, xcom_config_disabled,
):
    """When enabled is false, returns empty list without fetching."""
    source = XSource(xcom_config_disabled)
    articles = await source.fetch("tech")

    assert articles == []
    mock_fetch_xml.assert_not_called()


@pytest.mark.asyncio
@patch(
    "intel.ingest.xcom.XSource._find_working_instance",
    new_callable=AsyncMock,
    return_value=None,
)
async def test_xcom_no_working_instance(mock_instance, xcom_config, caplog):
    """When no Nitter instance responds, returns empty with a warning."""
    source = XSource(xcom_config)
    articles = await source.fetch("tech")

    assert articles == []
    assert any(
        "No working Nitter instance found" in r.message
        for r in caplog.records
    )


@pytest.mark.asyncio
@patch("intel.ingest.xcom.extract_content", new_callable=AsyncMock)
@patch("intel.ingest.xcom.XSource._fetch_feed_xml", new_callable=AsyncMock)
@patch(
    "intel.ingest.xcom.XSource._find_working_instance",
    new_callable=AsyncMock,
    return_value=INSTANCE,
)
async def test_xcom_embedded_link_extraction(
    mock_instance, mock_fetch_xml, mock_extract,
):
    """When a tweet contains a URL, extract_content is called for it."""
    mock_fetch_xml.return_value = MOCK_RSS_WITH_LINK
    mock_extract.return_value = "Full article content about AI advances."

    config = {
        "sources": {
            "xcom": {
                "enabled": True,
                "instance_url": INSTANCE,
                "accounts": {
                    "tech": ["techuser"],
                },
                "queries": {},
            }
        }
    }

    source = XSource(config)
    articles = await source.fetch("tech")

    assert len(articles) == 1
    mock_extract.assert_called_once_with("https://example.com/article")
    assert "Full article content about AI advances." in articles[0].content
