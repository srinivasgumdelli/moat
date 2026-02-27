"""X.com source fetcher via Nitter instance RSS feeds — free, no auth.

Nitter instances are fragile (depend on pooled X accounts). This source
tries multiple instances with automatic fallback. Disabled by default —
enable in config when a working instance is available.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from time import mktime

import feedparser
import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article
from intel.retry import retry_async

logger = logging.getLogger(__name__)

# Nitter instances to try in order (first working one wins)
DEFAULT_INSTANCES = [
    "https://xcancel.com",
    "https://nitter.poast.org",
]


@register_source("xcom")
class XSource(BaseSource):
    """Fetch content from X.com via Nitter instance RSS feeds."""

    @property
    def name(self) -> str:
        return "xcom"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("xcom", {})
        if not cfg.get("enabled", False):
            return []

        accounts = cfg.get("accounts", {}).get(topic, [])
        queries = cfg.get("queries", {}).get(topic, [])

        if not accounts and not queries:
            return []

        # Build instance list: explicit config first, then defaults
        configured = cfg.get("instance_url", "")
        if configured:
            instances = [configured.rstrip("/")]
        else:
            instances = list(DEFAULT_INSTANCES)

        # Find a working instance
        instance = await self._find_working_instance(instances)
        if not instance:
            logger.warning("No working Nitter instance found — skipping X.com")
            return []

        articles = []

        for username in accounts:
            try:
                url = f"{instance}/{username}/rss"
                results = await self._fetch_rss(url, topic, username)
                articles.extend(results)
            except Exception:
                logger.warning(
                    "X.com fetch failed for @%s", username,
                )

        for query in queries:
            try:
                url = f"{instance}/search/rss?f=tweets&q={query}"
                results = await self._fetch_rss(url, topic)
                articles.extend(results)
            except Exception:
                logger.warning(
                    "X.com search failed for '%s'", query,
                )

        logger.info(
            "X.com fetched %d articles for topic '%s' via %s",
            len(articles), topic, instance,
        )
        return articles

    async def _find_working_instance(
        self, instances: list[str],
    ) -> str | None:
        """Probe instances and return the first one that responds."""
        for instance in instances:
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    resp = await client.get(f"{instance}/x/rss")
                    if resp.status_code < 500:
                        logger.debug("Using Nitter instance: %s", instance)
                        return instance
            except Exception:
                logger.debug("Instance %s unreachable", instance)
        return None

    async def _fetch_rss(
        self, rss_url: str, topic: str, username: str | None = None,
    ) -> list[Article]:
        """Fetch and parse an RSS feed from the Nitter instance."""
        raw_xml = await retry_async(
            self._fetch_feed_xml, rss_url,
            max_retries=2, base_delay=1.0,
        )

        if not raw_xml:
            return []

        feed = feedparser.parse(raw_xml)
        articles = []

        for entry in feed.entries:
            link = entry.get("link", "")
            if not link:
                continue

            # Parse author from entry or feed
            author = username
            if not author:
                raw_author = (
                    entry.get("author", "")
                    or feed.feed.get("title", "")
                )
                author = _extract_username(raw_author)

            # Build title from author + first ~80 chars of text
            raw_text = entry.get("title", "") or entry.get("summary", "")
            clean_text = _strip_html_tags(raw_text)
            snippet = clean_text[:80].rstrip()
            if len(clean_text) > 80:
                snippet += "..."
            title = f"@{author}: {snippet}" if author else snippet

            # Full content
            content = clean_text
            urls_in_text = _extract_urls(clean_text)
            for embedded_url in urls_in_text[:1]:
                try:
                    extracted = await extract_content(embedded_url)
                    if extracted:
                        content = f"{clean_text}\n\n{extracted}"
                        break
                except Exception:
                    pass

            # Parse published time
            published_at = None
            if (
                hasattr(entry, "published_parsed")
                and entry.published_parsed
            ):
                try:
                    published_at = datetime.fromtimestamp(
                        mktime(entry.published_parsed),
                    )
                except (ValueError, OSError):
                    pass

            articles.append(
                Article(
                    url=link,
                    title=title,
                    content=content or title,
                    source_name=f"@{author}" if author else "X.com",
                    source_type="xcom",
                    topic=topic,
                    published_at=published_at,
                ),
            )

        return articles

    @staticmethod
    async def _fetch_feed_xml(url: str) -> str | None:
        """Fetch raw RSS XML from the Nitter instance."""
        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True,
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.text


def _strip_html_tags(text: str) -> str:
    """Remove HTML tags from text."""
    clean = re.sub(r"<[^>]+>", "", text)
    clean = clean.replace("&nbsp;", " ").replace("&amp;", "&")
    clean = clean.replace("&lt;", "<").replace("&gt;", ">")
    return re.sub(r"\s+", " ", clean).strip()


def _extract_username(raw: str) -> str:
    """Extract a username from Nitter feed author/title strings."""
    match = re.search(r"@(\w+)", raw)
    if match:
        return match.group(1)
    return raw.strip().split("/")[0].strip()


def _extract_urls(text: str) -> list[str]:
    """Extract HTTP(S) URLs from text, excluding x.com/twitter links."""
    urls = re.findall(r"https?://[^\s<>\"']+", text)
    return [
        u for u in urls
        if not re.match(r"https?://(www\.)?(twitter\.com|x\.com)/", u)
    ]
