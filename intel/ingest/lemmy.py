"""Lemmy source fetcher via REST API."""

from __future__ import annotations

import logging
from datetime import datetime

import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article
from intel.retry import retry_async

logger = logging.getLogger(__name__)

DEFAULT_INSTANCE = "https://lemmy.world"


@register_source("lemmy")
class LemmySource(BaseSource):
    """Fetch articles from Lemmy communities via REST API."""

    @property
    def name(self) -> str:
        return "lemmy"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("lemmy", {})
        if not cfg.get("enabled", False):
            return []

        communities = cfg.get("communities", {}).get(topic, [])
        if not communities:
            return []

        instance = cfg.get("instance_url", DEFAULT_INSTANCE).rstrip("/")
        sort = cfg.get("sort", "Hot")
        limit = cfg.get("limit", 15)

        articles = []
        for community in communities:
            try:
                results = await self._fetch_community(
                    instance, community, topic, sort, limit,
                )
                articles.extend(results)
            except Exception:
                logger.warning(
                    "Lemmy fetch failed for c/%s",
                    community, exc_info=True,
                )

        logger.info(
            "Lemmy fetched %d articles for topic '%s'",
            len(articles), topic,
        )
        return articles

    async def _fetch_community(
        self,
        instance: str,
        community: str,
        topic: str,
        sort: str,
        limit: int,
    ) -> list[Article]:
        """Fetch posts from a single Lemmy community."""
        data = await retry_async(
            self._fetch_api, instance, community, sort, limit,
        )

        articles = []
        for post_view in data.get("posts", []):
            post = post_view.get("post", {})
            title = post.get("name", "")
            if not title:
                continue

            url = post.get("url", "") or post.get("ap_id", "")
            if not url:
                continue

            content = post.get("body", "") or title
            if post.get("url") and len(content) < 200:
                try:
                    extracted = await extract_content(post["url"])
                    if extracted:
                        content = extracted
                except Exception:
                    pass

            published_at = None
            published_str = post.get("published")
            if published_str:
                try:
                    published_at = datetime.fromisoformat(
                        published_str.replace("Z", "+00:00"),
                    )
                except ValueError:
                    pass

            articles.append(
                Article(
                    url=url,
                    title=title,
                    content=content,
                    source_name=f"c/{community}",
                    source_type="lemmy",
                    topic=topic,
                    published_at=published_at,
                ),
            )

        return articles

    @staticmethod
    async def _fetch_api(
        instance: str, community: str, sort: str, limit: int,
    ) -> dict:
        api_url = f"{instance}/api/v3/post/list"
        params = {
            "community_name": community,
            "sort": sort,
            "limit": limit,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(api_url, params=params)
            resp.raise_for_status()
            return resp.json()
