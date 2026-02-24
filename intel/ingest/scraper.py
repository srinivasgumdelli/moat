"""Article content extraction using trafilatura."""

from __future__ import annotations

import logging

import trafilatura

logger = logging.getLogger(__name__)


async def extract_content(url: str) -> str | None:
    """Extract main article text from a URL using trafilatura."""
    try:
        downloaded = trafilatura.fetch_url(url)
        if not downloaded:
            return None
        text = trafilatura.extract(downloaded, include_comments=False, include_tables=False)
        return text
    except Exception:
        logger.debug("Extraction failed for %s", url)
        return None
