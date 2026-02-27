"""Hacker News source fetcher via Algolia search API."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article
from intel.retry import retry_async

logger = logging.getLogger(__name__)

HN_ALGOLIA_URL = "https://hn.algolia.com/api/v1/search_by_date"


@register_source("hackernews")
class HackerNewsSource(BaseSource):
    """Fetch articles from Hacker News via Algolia search API."""

    @property
    def name(self) -> str:
        return "hackernews"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("hackernews", {})
        if not cfg.get("enabled", False):
            return []

        queries = cfg.get("queries", {}).get(topic, [])
        if not queries:
            return []

        min_points = cfg.get("min_points", 10)
        limit = cfg.get("limit", 15)

        articles = []
        for query in queries:
            try:
                results = await self._search(query, topic, min_points, limit)
                articles.extend(results)
            except Exception:
                logger.exception(
                    "HN search failed for query '%s'", query,
                )

        logger.info(
            "HN fetched %d articles for topic '%s'",
            len(articles), topic,
        )
        return articles

    async def _search(
        self, query: str, topic: str, min_points: int, limit: int,
    ) -> list[Article]:
        """Execute a single Algolia search query."""
        data = await retry_async(
            self._fetch_api, query, limit,
        )

        articles = []
        for hit in data.get("hits", []):
            title = hit.get("title", "")
            if not title:
                continue

            points = hit.get("points") or 0
            if points < min_points:
                continue

            url = hit.get("url", "")
            story_id = hit.get("objectID", "")
            if not url and story_id:
                url = f"https://news.ycombinator.com/item?id={story_id}"
            if not url:
                continue

            author = hit.get("author", "")
            content = title
            if len(content) < 200:
                try:
                    extracted = await extract_content(url)
                    if extracted:
                        content = extracted
                except Exception:
                    pass

            published_at = None
            created_ts = hit.get("created_at_i")
            if created_ts:
                try:
                    published_at = datetime.fromtimestamp(
                        created_ts, tz=timezone.utc,
                    )
                except (ValueError, OSError):
                    pass

            articles.append(
                Article(
                    url=url,
                    title=title,
                    content=content,
                    source_name=f"HN/{author}" if author else "HN",
                    source_type="hackernews",
                    topic=topic,
                    published_at=published_at,
                ),
            )

        return articles

    @staticmethod
    async def _fetch_api(query: str, limit: int) -> dict:
        params = {
            "query": query,
            "tags": "story",
            "hitsPerPage": limit,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(HN_ALGOLIA_URL, params=params)
            resp.raise_for_status()
            return resp.json()
