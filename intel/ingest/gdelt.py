"""GDELT Doc 2.0 API source fetcher."""

from __future__ import annotations

import logging
from datetime import datetime

import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article

logger = logging.getLogger(__name__)

GDELT_API_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

TOPIC_QUERIES = {
    "tech": "artificial intelligence OR machine learning OR tech regulation",
    "geopolitics": "international relations OR geopolitical OR conflict OR diplomacy",
    "finance": "financial markets OR central bank OR economic policy OR stock market",
}


@register_source("gdelt")
class GDELTSource(BaseSource):
    """Fetch articles from the GDELT Doc 2.0 API."""

    @property
    def name(self) -> str:
        return "gdelt"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("gdelt", {})
        if not cfg.get("enabled", False):
            return []

        max_articles = cfg.get("max_articles", 50)
        query = TOPIC_QUERIES.get(topic, topic)

        params = {
            "query": query,
            "mode": "ArtList",
            "maxrecords": str(max_articles),
            "format": "json",
            "sort": "DateDesc",
            "timespan": "24h",
        }

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(GDELT_API_URL, params=params)
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            logger.exception("GDELT API request failed for topic '%s'", topic)
            return []

        raw_articles = data.get("articles", [])
        articles = []

        for item in raw_articles:
            url = item.get("url", "")
            title = item.get("title", "")
            if not url or not title:
                continue

            published_at = None
            if item.get("seendate"):
                try:
                    published_at = datetime.strptime(item["seendate"], "%Y%m%dT%H%M%SZ")
                except ValueError:
                    pass

            # Try to extract full content
            content = title
            try:
                extracted = await extract_content(url)
                if extracted:
                    content = extracted
            except Exception:
                pass

            articles.append(
                Article(
                    url=url,
                    title=title,
                    content=content,
                    source_name=item.get("domain", "GDELT"),
                    source_type="gdelt",
                    topic=topic,
                    published_at=published_at,
                )
            )

        logger.info("GDELT fetched %d articles for topic '%s'", len(articles), topic)
        return articles
