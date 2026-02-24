"""Tests for config loading and env var resolution."""

from __future__ import annotations

from intel.config import (
    get_active_sources,
    get_active_topics,
    get_db_path,
    get_llm_task_config,
    load_config,
)


def test_load_config(sample_config):
    """Config loads and has expected structure."""
    assert "llm" in sample_config
    assert "sources" in sample_config
    assert "pipeline" in sample_config


def test_env_var_resolution(tmp_path, monkeypatch):
    """Environment variables in ${VAR} format are resolved."""
    monkeypatch.setenv("TEST_API_KEY", "my-secret-key")
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("""
llm:
  providers:
    test:
      api_key: "${TEST_API_KEY}"
      base_url: "https://api.example.com"
""")
    config = load_config(str(cfg_path))
    assert config["llm"]["providers"]["test"]["api_key"] == "my-secret-key"


def test_get_active_sources(sample_config):
    """Only enabled sources are returned."""
    sources = get_active_sources(sample_config)
    assert "rss" in sources


def test_get_active_topics(sample_config):
    """Topics come from config."""
    topics = get_active_topics(sample_config)
    assert "tech" in topics


def test_get_llm_task_config(sample_config):
    """Task-to-provider mapping works."""
    cfg = get_llm_task_config(sample_config, "summarize")
    assert cfg["provider_name"] == "mock"
    assert cfg["provider_type"] == "openai_compatible"
    assert cfg["model"] == "test-model"


def test_get_db_path(sample_config):
    """DB path is extracted from config."""
    path = get_db_path(sample_config)
    assert path.endswith("test.db")
