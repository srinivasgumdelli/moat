"""Abstract base class for LLM providers."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class LLMResponse:
    """Response from an LLM call."""

    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    cost_usd: float = 0.0


class BaseLLMProvider(ABC):
    """Base class for LLM providers."""

    def __init__(
        self,
        api_key: str,
        base_url: str,
        default_model: str,
        max_retries: int = 3,
        timeout: int = 120,
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.default_model = default_model
        self.active_model = default_model
        self.max_retries = max_retries
        self.timeout = timeout

    @abstractmethod
    async def complete(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        temperature: float = 0.3,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        """Send a completion request and return the response."""
        ...

    @property
    @abstractmethod
    def provider_name(self) -> str:
        """Human-readable provider name."""
        ...

    def _track_cost(self, response: LLMResponse) -> None:
        """Report token usage to the pipeline cost tracker."""
        # Import here to avoid circular import
        from intel.pipeline import get_cost_tracker

        tracker = get_cost_tracker()
        if tracker and (response.input_tokens or response.output_tokens):
            tracker.track(
                response.input_tokens,
                response.output_tokens,
                response.model,
            )
