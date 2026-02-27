"""Load and validate configuration from YAML with env var substitution."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import yaml


def _load_dotenv(path: str | Path = ".env") -> None:
    """Load a .env file into os.environ (without overwriting existing vars)."""
    env_path = Path(path)
    if not env_path.is_file():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


def _resolve_env_vars(value: Any) -> Any:
    """Recursively resolve ${ENV_VAR} patterns in config values."""
    if isinstance(value, str):
        pattern = re.compile(r"\$\{([^}]+)\}")
        match = pattern.search(value)
        if match:
            env_key = match.group(1)
            env_val = os.environ.get(env_key, "")
            # If the entire string is a single env var, return the resolved value
            if match.group(0) == value:
                return env_val
            # Otherwise, substitute within the string
            return pattern.sub(lambda m: os.environ.get(m.group(1), ""), value)
        return value
    if isinstance(value, dict):
        return {k: _resolve_env_vars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve_env_vars(item) for item in value]
    return value


def load_config(path: str | Path = "config.yaml") -> dict[str, Any]:
    """Load config from YAML file and resolve environment variables."""
    _load_dotenv()

    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")

    with open(path) as f:
        raw = yaml.safe_load(f)

    return _resolve_env_vars(raw)


def get_active_sources(config: dict) -> list[str]:
    """Return list of enabled source names."""
    sources = config.get("sources", {})
    return [name for name, cfg in sources.items() if cfg.get("enabled", False)]


def get_active_topics(config: dict) -> list[str]:
    """Return configured topic list."""
    return config.get("pipeline", {}).get("topics", ["tech", "geopolitics", "finance"])


def get_llm_task_config(config: dict, task: str) -> dict:
    """Get provider name and model for a given LLM task."""
    tasks = config.get("llm", {}).get("tasks", {})
    task_cfg = tasks.get(task, {})
    provider_name = task_cfg.get("provider", "deepseek")
    model_override = task_cfg.get("model")

    providers = config.get("llm", {}).get("providers", {})
    provider_cfg = providers.get(provider_name, {})

    return {
        "provider_name": provider_name,
        "provider_type": provider_cfg.get("type", "openai_compatible"),
        "api_key": provider_cfg.get("api_key", ""),
        "base_url": provider_cfg.get("base_url", ""),
        "model": model_override or provider_cfg.get("default_model", ""),
        "max_retries": provider_cfg.get("max_retries", 3),
        "timeout": provider_cfg.get("timeout", 120),
    }


def get_db_path(config: dict) -> str:
    """Get database path from config."""
    return config.get("database", {}).get("path", "data/intel.db")
