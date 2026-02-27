"""Retry logic with exponential backoff for API calls."""

from __future__ import annotations

import asyncio
import logging
from typing import TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

RETRYABLE_HTTP_CODES = {429, 500, 502, 503, 504}
RETRYABLE_EXCEPTIONS = (
    httpx.TimeoutException,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
    ConnectionError,
    TimeoutError,
)


async def retry_async(
    fn,
    *args,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    **kwargs,
):
    """Call an async function with exponential backoff on transient failures.

    Retries on:
    - httpx timeout/connection errors
    - HTTP 429 (rate limit) and 5xx (server errors)
    - anthropic rate limit / overloaded errors
    """
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            return await fn(*args, **kwargs)
        except RETRYABLE_EXCEPTIONS as exc:
            last_exc = exc
            if attempt == max_retries:
                break
            delay = min(base_delay * (2**attempt), max_delay)
            logger.warning(
                "Retry %d/%d after %s: %s (waiting %.1fs)",
                attempt + 1, max_retries, type(exc).__name__, exc, delay,
            )
            await asyncio.sleep(delay)
        except httpx.HTTPStatusError as exc:
            last_exc = exc
            if exc.response.status_code in RETRYABLE_HTTP_CODES:
                if attempt == max_retries:
                    break
                # Use Retry-After header if present (rate limiting)
                retry_after = exc.response.headers.get("retry-after")
                if retry_after:
                    try:
                        delay = min(float(retry_after), max_delay)
                    except ValueError:
                        delay = min(base_delay * (2**attempt), max_delay)
                else:
                    delay = min(base_delay * (2**attempt), max_delay)
                logger.warning(
                    "Retry %d/%d after HTTP %d (waiting %.1fs)",
                    attempt + 1, max_retries,
                    exc.response.status_code, delay,
                )
                await asyncio.sleep(delay)
            else:
                raise
        except Exception as exc:
            # Check for anthropic-specific retryable errors
            exc_name = type(exc).__name__
            if exc_name in (
                "RateLimitError", "OverloadedError",
                "InternalServerError", "APIConnectionError",
            ):
                last_exc = exc
                if attempt == max_retries:
                    break
                delay = min(base_delay * (2**attempt), max_delay)
                logger.warning(
                    "Retry %d/%d after %s (waiting %.1fs)",
                    attempt + 1, max_retries, exc_name, delay,
                )
                await asyncio.sleep(delay)
            else:
                raise

    raise last_exc  # type: ignore[misc]
