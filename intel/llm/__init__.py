"""LLM provider registry and task routing."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intel.llm.base import BaseLLMProvider

PROVIDERS: dict[str, type[BaseLLMProvider]] = {}

_provider_instances: dict[str, BaseLLMProvider] = {}


def register_provider(name: str):
    """Decorator to register an LLM provider."""

    def decorator(cls):
        PROVIDERS[name] = cls
        return cls

    return decorator


def get_provider_for_task(config: dict, task: str) -> BaseLLMProvider:
    """Get the configured LLM provider instance for a given task."""
    from intel.config import get_llm_task_config

    task_cfg = get_llm_task_config(config, task)
    provider_type = task_cfg["provider_type"]
    provider_name = task_cfg["provider_name"]
    model = task_cfg["model"]

    # Cache key is provider_name so we reuse connections
    cache_key = provider_name
    if cache_key not in _provider_instances:
        if provider_type not in PROVIDERS:
            raise ValueError(f"Unknown LLM provider type: {provider_type}")
        cls = PROVIDERS[provider_type]
        _provider_instances[cache_key] = cls(
            api_key=task_cfg["api_key"],
            base_url=task_cfg["base_url"],
            default_model=model,
        )

    provider = _provider_instances[cache_key]
    provider.active_model = model
    return provider


# Import implementations to trigger registration
from intel.llm.anthropic_provider import AnthropicProvider  # noqa: E402, F401
from intel.llm.openai_compat import OpenAICompatibleProvider  # noqa: E402, F401
