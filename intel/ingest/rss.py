"""RSS feed source fetcher."""

from __future__ import annotations

import logging
from datetime import datetime
from time import mktime

import feedparser

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article

logger = logging.getLogger(__name__)


@register_source("rss")
class RSSSource(BaseSource):
    """Fetch articles from configured RSS feeds."""

    @property
    def name(self) -> str:
        return "rss"

    async def fetch(self, topic: str) -> list[Article]:
        feeds = self.config.get("sources", {}).get("rss", {}).get("feeds", {}).get(topic, [])
        articles = []

        for feed_cfg in feeds:
            url = feed_cfg["url"]
            source_name = feed_cfg.get("name", url)
            try:
                entries = await self._parse_feed(url, source_name, topic)
                articles.extend(entries)
            except Exception:
                logger.exception("Failed to fetch RSS feed: %s", url)

        logger.info("RSS fetched %d articles for topic '%s'", len(articles), topic)
        return articles

    async def _parse_feed(
        self, url: str, source_name: str, topic: str
    ) -> list[Article]:
        """Parse a single RSS feed and extract articles."""
        feed = feedparser.parse(url)
        articles = []

        for entry in feed.entries:
            link = entry.get("link", "")
            title = entry.get("title", "")
            if not link or not title:
                continue

            published_at = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
                published_at = datetime.fromtimestamp(mktime(entry.published_parsed))

            # Use feed summary as fallback, try full content extraction
            content = entry.get("summary", "")
            if len(content) < 200:
                try:
                    extracted = await extract_content(link)
                    if extracted:
                        content = extracted
                except Exception:
                    logger.debug("Content extraction failed for %s", link)

            if not content:
                content = title

            articles.append(
                Article(
                    url=link,
                    title=title,
                    content=content,
                    source_name=source_name,
                    source_type="rss",
                    topic=topic,
                    published_at=published_at,
                )
            )

        return articles
