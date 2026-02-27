"""Bluesky source fetcher via AT Protocol public API."""

from __future__ import annotations

import logging
import re
from datetime import datetime

import httpx

from intel.ingest import register_source
from intel.ingest.base import BaseSource
from intel.ingest.scraper import extract_content
from intel.models import Article
from intel.retry import retry_async

logger = logging.getLogger(__name__)

BSKY_SEARCH_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"


def _at_uri_to_web_url(at_uri: str) -> str:
    """Convert an AT Protocol URI to a bsky.app web URL.

    at://did:plc:abc123/app.bsky.feed.post/xyz789
    → https://bsky.app/profile/did:plc:abc123/post/xyz789
    """
    match = re.match(
        r"at://([^/]+)/app\.bsky\.feed\.post/(.+)", at_uri,
    )
    if match:
        did, rkey = match.groups()
        return f"https://bsky.app/profile/{did}/post/{rkey}"
    return at_uri


@register_source("bluesky")
class BlueskySource(BaseSource):
    """Fetch posts from Bluesky via AT Protocol search API."""

    @property
    def name(self) -> str:
        return "bluesky"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("bluesky", {})
        if not cfg.get("enabled", False):
            return []

        queries = cfg.get("queries", {}).get(topic, [])
        if not queries:
            return []

        limit = cfg.get("limit", 15)

        articles = []
        for query in queries:
            try:
                results = await self._search(query, topic, limit)
                articles.extend(results)
            except Exception:
                logger.exception(
                    "Bluesky search failed for query '%s'", query,
                )

        logger.info(
            "Bluesky fetched %d articles for topic '%s'",
            len(articles), topic,
        )
        return articles

    async def _search(
        self, query: str, topic: str, limit: int,
    ) -> list[Article]:
        """Execute a single Bluesky search query."""
        data = await retry_async(
            self._fetch_api, query, limit,
        )

        articles = []
        for post in data.get("posts", []):
            record = post.get("record", {})
            text = record.get("text", "")
            if not text:
                continue

            author_obj = post.get("author", {})
            handle = author_obj.get("handle", "")

            # Build title: @handle: first 80 chars...
            snippet = text[:80].rstrip()
            if len(text) > 80:
                snippet += "..."
            title = f"@{handle}: {snippet}" if handle else snippet

            # Post URL from AT URI
            uri = post.get("uri", "")
            url = _at_uri_to_web_url(uri) if uri else ""
            if not url:
                continue

            # Content: full text, plus embedded link content if available
            content = text
            embed = post.get("embed", {}) or {}
            external = embed.get("external", {}) or {}
            embed_url = external.get("uri", "")
            if embed_url:
                try:
                    extracted = await extract_content(embed_url)
                    if extracted:
                        content = f"{text}\n\n{extracted}"
                except Exception:
                    pass

            published_at = None
            created_at = record.get("createdAt", "")
            if created_at:
                try:
                    published_at = datetime.fromisoformat(
                        created_at.replace("Z", "+00:00"),
                    )
                except ValueError:
                    pass

            articles.append(
                Article(
                    url=url,
                    title=title,
                    content=content or title,
                    source_name=f"@{handle}" if handle else "Bluesky",
                    source_type="bluesky",
                    topic=topic,
                    published_at=published_at,
                ),
            )

        return articles

    @staticmethod
    async def _fetch_api(query: str, limit: int) -> dict:
        params = {
            "q": query,
            "sort": "latest",
            "limit": limit,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(BSKY_SEARCH_URL, params=params)
            resp.raise_for_status()
            return resp.json()
