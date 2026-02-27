"""Reddit source fetcher via old.reddit.com RSS feeds (no auth required)."""

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

USER_AGENT = "intel-digest/0.1 (personal news aggregator)"


@register_source("reddit")
class RedditSource(BaseSource):
    """Fetch articles from Reddit via old.reddit.com RSS feeds."""

    @property
    def name(self) -> str:
        return "reddit"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("reddit", {})
        if not cfg.get("enabled", False):
            return []

        subreddits = cfg.get("subreddits", {}).get(topic, [])
        if not subreddits:
            return []

        limit = cfg.get("limit", 15)

        articles = []
        for sub in subreddits:
            try:
                results = await self._fetch_subreddit(sub, topic, limit)
                articles.extend(results)
            except Exception:
                logger.warning(
                    "Reddit RSS fetch failed for r/%s",
                    sub, exc_info=True,
                )

        logger.info(
            "Reddit fetched %d articles for topic '%s'",
            len(articles), topic,
        )
        return articles

    async def _fetch_subreddit(
        self, subreddit: str, topic: str, limit: int,
    ) -> list[Article]:
        """Fetch hot posts from a subreddit via RSS."""
        url = (
            f"https://old.reddit.com/r/{subreddit}/hot/.rss"
            f"?limit={limit}"
        )
        raw_xml = await retry_async(
            self._fetch_rss, url,
            max_retries=2, base_delay=1.0,
        )
        if not raw_xml:
            return []

        feed = feedparser.parse(raw_xml)
        articles = []

        for entry in feed.entries:
            link = entry.get("link", "")
            title = entry.get("title", "")
            if not link or not title:
                continue

            # RSS content is raw HTML — strip tags for clean text
            raw_summary = entry.get("summary", "") or title
            content = _strip_html(raw_summary)
            # If the entry links to an external URL, extract content
            if link and "reddit.com" not in link:
                try:
                    extracted = await extract_content(link)
                    if extracted:
                        content = extracted
                except Exception:
                    logger.debug(
                        "Content extraction failed for %s", link,
                    )

            # Parse published time
            published_at = None
            if hasattr(entry, "published_parsed") and entry.published_parsed:
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
                    content=content,
                    source_name=f"r/{subreddit}",
                    source_type="reddit",
                    topic=topic,
                    published_at=published_at,
                ),
            )

        return articles

    @staticmethod
    async def _fetch_rss(url: str) -> str | None:
        """Fetch raw RSS XML from old.reddit.com."""
        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True,
        ) as client:
            resp = await client.get(
                url, headers={"User-Agent": USER_AGENT},
            )
            resp.raise_for_status()
            return resp.text


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    clean = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    clean = re.sub(r"<[^>]+>", "", clean)
    clean = clean.replace("&nbsp;", " ").replace("&amp;", "&")
    clean = clean.replace("&lt;", "<").replace("&gt;", ">")
    clean = clean.replace("&#39;", "'").replace("&quot;", '"')
    return re.sub(r"\s+", " ", clean).strip()
