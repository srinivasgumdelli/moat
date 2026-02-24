"""Batching logic to minimize LLM API calls."""

from __future__ import annotations

import asyncio
import logging

from intel.llm.base import BaseLLMProvider, LLMResponse

logger = logging.getLogger(__name__)


async def batch_complete(
    provider: BaseLLMProvider,
    prompts: list[str],
    system: str = "",
    max_concurrent: int = 3,
    temperature: float = 0.3,
    max_tokens: int = 2000,
) -> list[LLMResponse]:
    """Run multiple LLM completions with concurrency control."""
    semaphore = asyncio.Semaphore(max_concurrent)

    async def _call(prompt: str) -> LLMResponse:
        async with semaphore:
            return await provider.complete(
                prompt, system=system, temperature=temperature, max_tokens=max_tokens
            )

    results = await asyncio.gather(*[_call(p) for p in prompts], return_exceptions=True)

    responses = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            logger.error("Batch call %d failed: %s", i, result)
            responses.append(LLMResponse(text="", model=provider.active_model))
        else:
            responses.append(result)

    return responses


def estimate_cost(
    input_tokens: int,
    output_tokens: int,
    model: str,
) -> float:
    """Rough cost estimate based on known pricing (per 1M tokens)."""
    pricing = {
        "deepseek-chat": (0.14, 0.28),
        "claude-sonnet-4-5-20250514": (3.0, 15.0),
        "claude-opus-4-6": (15.0, 75.0),
        "claude-haiku-4-5-20251001": (0.80, 4.0),
    }
    input_rate, output_rate = pricing.get(model, (1.0, 2.0))
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
