"""Anthropic Claude LLM provider."""

from __future__ import annotations

import logging

import anthropic

from intel.llm import register_provider
from intel.llm.base import BaseLLMProvider, LLMResponse

logger = logging.getLogger(__name__)


@register_provider("anthropic")
class AnthropicProvider(BaseLLMProvider):
    """Provider for Anthropic Claude models."""

    @property
    def provider_name(self) -> str:
        return "anthropic"

    async def complete(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        temperature: float = 0.3,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        model = model or self.active_model or self.default_model
        client = anthropic.AsyncAnthropic(api_key=self.api_key)

        kwargs = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            kwargs["system"] = system

        response = await client.messages.create(**kwargs)

        text = response.content[0].text if response.content else ""
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens

        return LLMResponse(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
        )
