"""Tests for retry logic."""

from __future__ import annotations

import pytest

from intel.retry import retry_async


@pytest.mark.asyncio
async def test_retry_succeeds_on_first_try():
    """No retries needed when function succeeds."""
    call_count = 0

    async def fn():
        nonlocal call_count
        call_count += 1
        return "ok"

    result = await retry_async(fn)
    assert result == "ok"
    assert call_count == 1


@pytest.mark.asyncio
async def test_retry_succeeds_after_transient_failure():
    """Retries on transient error and eventually succeeds."""
    call_count = 0

    async def fn():
        nonlocal call_count
        call_count += 1
        if call_count < 3:
            raise ConnectionError("transient")
        return "ok"

    result = await retry_async(fn, max_retries=3, base_delay=0.01)
    assert result == "ok"
    assert call_count == 3


@pytest.mark.asyncio
async def test_retry_exhausts_retries():
    """Raises after max retries exhausted."""

    async def fn():
        raise TimeoutError("always fails")

    with pytest.raises(TimeoutError, match="always fails"):
        await retry_async(fn, max_retries=2, base_delay=0.01)


@pytest.mark.asyncio
async def test_retry_does_not_retry_non_transient():
    """Non-retryable exceptions are raised immediately."""
    call_count = 0

    async def fn():
        nonlocal call_count
        call_count += 1
        raise ValueError("bad input")

    with pytest.raises(ValueError, match="bad input"):
        await retry_async(fn, max_retries=3, base_delay=0.01)
    assert call_count == 1
