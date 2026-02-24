"""OpenAI-compatible LLM provider (DeepSeek, Ollama, vLLM, LM Studio, etc.)."""

from __future__ import annotations

import logging

import httpx

from intel.llm import register_provider
from intel.llm.base import BaseLLMProvider, LLMResponse

logger = logging.getLogger(__name__)


@register_provider("openai_compatible")
class OpenAICompatibleProvider(BaseLLMProvider):
    """Provider for any OpenAI-compatible API."""

    @property
    def provider_name(self) -> str:
        return "openai_compatible"

    async def complete(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        temperature: float = 0.3,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        model = model or self.active_model or self.default_model
        url = f"{self.base_url.rstrip('/')}/chat/completions"

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        usage = data.get("usage", {})
        input_tokens = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)

        return LLMResponse(
            text=choice["message"]["content"],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model,
        )
