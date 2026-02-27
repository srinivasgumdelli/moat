"""Reddit source fetcher using OAuth2 API (free script app credentials)."""

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

USER_AGENT = "intel-digest/0.1 (personal news aggregator)"
TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
OAUTH_BASE = "https://oauth.reddit.com"


@register_source("reddit")
class RedditSource(BaseSource):
    """Fetch articles from Reddit via OAuth2 API."""

    @property
    def name(self) -> str:
        return "reddit"

    async def fetch(self, topic: str) -> list[Article]:
        cfg = self.config.get("sources", {}).get("reddit", {})
        if not cfg.get("enabled", False):
            return []

        client_id = cfg.get("client_id", "")
        client_secret = cfg.get("client_secret", "")
        if not client_id or not client_secret:
            logger.warning("Reddit client_id/client_secret not configured")
            return []

        subreddits = cfg.get("subreddits", {}).get(topic, [])
        if not subreddits:
            return []

        limit = cfg.get("limit", 15)
        min_score = cfg.get("min_score", 10)

        # Get OAuth2 bearer token
        token = await self._get_token(client_id, client_secret)
        if not token:
            logger.warning("Failed to obtain Reddit OAuth token")
            return []

        articles = []
        for sub in subreddits:
            try:
                results = await self._fetch_subreddit(
                    sub, topic, limit, min_score, token,
                )
                articles.extend(results)
            except Exception:
                logger.exception("Reddit fetch failed for r/%s", sub)

        logger.info(
            "Reddit fetched %d articles for topic '%s'",
            len(articles), topic,
        )
        return articles

    async def _fetch_subreddit(
        self, subreddit: str, topic: str, limit: int, min_score: int,
        token: str,
    ) -> list[Article]:
        """Fetch hot posts from a single subreddit."""
        data = await retry_async(
            self._fetch_json, subreddit, limit, token,
            max_retries=2, base_delay=1.0,
        )

        articles = []
        for child in data.get("data", {}).get("children", []):
            post = child.get("data", {})

            # Skip stickied posts
            if post.get("stickied", False):
                continue

            # Skip low-score posts
            if post.get("score", 0) < min_score:
                continue

            title = post.get("title", "")
            url = post.get("url", "")
            permalink = f"https://www.reddit.com{post.get('permalink', '')}"

            if not title:
                continue

            # Self-posts: use selftext as content
            if post.get("is_self", False):
                content = post.get("selftext", "") or title
                article_url = permalink
            else:
                # Link posts: try to extract content from linked URL
                article_url = url or permalink
                content = title
                if url:
                    try:
                        extracted = await extract_content(url)
                        if extracted:
                            content = extracted
                    except Exception:
                        logger.debug(
                            "Content extraction failed for %s", url,
                        )

            # Parse published time
            published_at = None
            created_utc = post.get("created_utc")
            if created_utc:
                try:
                    published_at = datetime.fromtimestamp(created_utc)
                except (ValueError, OSError):
                    pass

            articles.append(
                Article(
                    url=article_url,
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
    async def _get_token(client_id: str, client_secret: str) -> str | None:
        """Obtain an OAuth2 bearer token using client credentials."""
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    auth=(client_id, client_secret),
                    headers={"User-Agent": USER_AGENT},
                )
                resp.raise_for_status()
                return resp.json().get("access_token")
        except Exception:
            logger.exception("Reddit OAuth token request failed")
            return None

    @staticmethod
    async def _fetch_json(
        subreddit: str, limit: int, token: str,
    ) -> dict:
        """Fetch subreddit JSON data via OAuth API."""
        url = f"{OAUTH_BASE}/r/{subreddit}/hot.json?limit={limit}"
        headers = {
            "User-Agent": USER_AGENT,
            "Authorization": f"Bearer {token}",
        }

        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True,
        ) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()
