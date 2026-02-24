"""Article content extraction using trafilatura."""

from __future__ import annotations

import logging

import httpx
import trafilatura

from intel.retry import retry_async

logger = logging.getLogger(__name__)


async def extract_content(url: str) -> str | None:
    """Extract main article text from a URL using trafilatura."""
    try:
        html = await retry_async(_fetch_html, url, max_retries=2, base_delay=0.5)
        if not html:
            return None
        text = trafilatura.extract(
            html, include_comments=False, include_tables=False,
        )
        return text
    except Exception:
        logger.debug("Extraction failed for %s", url)
        return None


async def _fetch_html(url: str) -> str | None:
    """Fetch raw HTML with httpx (async, retryable)."""
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.text
