"""Serper.dev news search source fetcher."""

from __future__ import annotations

import logging
from datetime import datetime

import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article

logger = logging.getLogger(__name__)

SERPER_API_URL = "https://google.serper.dev/news"


@register_source("serper")
class SerperSource(BaseSource):
    """Fetch articles from Serper.dev news search API."""

    @property
    def name(self) -> str:
        return "serper"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("serper", {})
        if not cfg.get("enabled", False):
            return []

        api_key = cfg.get("api_key", "")
        if not api_key:
            logger.warning("Serper API key not configured")
            return []

        queries = cfg.get("queries", {}).get(topic, [])
        if not queries:
            return []

        articles = []
        for query in queries:
            try:
                results = await self._search(api_key, query, topic)
                articles.extend(results)
            except Exception:
                logger.exception("Serper search failed for query '%s'", query)

        logger.info("Serper fetched %d articles for topic '%s'", len(articles), topic)
        return articles

    async def _search(self, api_key: str, query: str, topic: str) -> list[Article]:
        """Execute a single Serper news search."""
        headers = {
            "X-API-KEY": api_key,
            "Content-Type": "application/json",
        }
        payload = {"q": query, "num": 10}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(SERPER_API_URL, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        articles = []
        for item in data.get("news", []):
            url = item.get("link", "")
            title = item.get("title", "")
            if not url or not title:
                continue

            content = item.get("snippet", title)
            if len(content) < 200:
                try:
                    extracted = await extract_content(url)
                    if extracted:
                        content = extracted
                except Exception:
                    pass

            published_at = None
            if item.get("date"):
                try:
                    published_at = datetime.fromisoformat(item["date"])
                except ValueError:
                    pass

            articles.append(
                Article(
                    url=url,
                    title=title,
                    content=content,
                    source_name=item.get("source", "Serper"),
                    source_type="serper",
                    topic=topic,
                    published_at=published_at,
                )
            )

        return articles
