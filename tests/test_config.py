"""Tests for config loading and env var resolution."""

from __future__ import annotations

from intel.config import (
    get_active_sources,
    get_active_topics,
    get_db_path,
    get_llm_task_config,
    get_topic_display,
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


def test_get_llm_task_config_json_mode():
    """json_mode passes through from provider config."""
    config = {
        "llm": {
            "providers": {
                "openai": {
                    "type": "openai_compatible",
                    "api_key": "sk-test",
                    "base_url": "https://api.openai.com/v1",
                    "default_model": "gpt-4o-mini",
                    "json_mode": True,
                },
                "local": {
                    "type": "openai_compatible",
                    "base_url": "http://localhost:11434/v1",
                    "default_model": "llama3",
                },
            },
            "tasks": {
                "summarize": {"provider": "openai"},
                "label_clusters": {"provider": "local"},
            },
        },
    }
    # Provider with json_mode: true
    cfg = get_llm_task_config(config, "summarize")
    assert cfg["json_mode"] is True

    # Provider without json_mode (defaults to False)
    cfg = get_llm_task_config(config, "label_clusters")
    assert cfg["json_mode"] is False


def test_get_topic_display_defaults():
    """Default topic display is returned when config has no topic_display."""
    config = {"pipeline": {"topics": ["tech", "finance"]}}
    display = get_topic_display(config)
    assert list(display.keys()) == ["tech", "finance"]
    assert display["tech"]["label"] == "TECH & AI"
    assert display["finance"]["emoji"] == "\U0001f4c8"
    assert display["finance"]["color"] == [0, 128, 0]


def test_get_topic_display_custom():
    """Custom topic display overrides defaults."""
    config = {
        "pipeline": {
            "topics": ["tech", "security"],
            "topic_display": {
                "tech": {"label": "TECHNOLOGY", "emoji": "\U0001f916", "color": [0, 0, 255]},
                "security": {"label": "CYBERSECURITY", "emoji": "\U0001f512", "color": [255, 0, 0]},
            },
        },
    }
    display = get_topic_display(config)
    assert display["tech"]["label"] == "TECHNOLOGY"
    assert display["security"]["label"] == "CYBERSECURITY"
    assert display["security"]["color"] == [255, 0, 0]


def test_get_topic_display_partial_override():
    """Partial config fills in missing fields from defaults."""
    config = {
        "pipeline": {
            "topics": ["tech"],
            "topic_display": {
                "tech": {"label": "TECHNOLOGY"},
            },
        },
    }
    display = get_topic_display(config)
    assert display["tech"]["label"] == "TECHNOLOGY"
    # emoji and color should fall back to defaults
    assert display["tech"]["emoji"] == "\U0001f4bb"
    assert display["tech"]["color"] == [0, 122, 204]
