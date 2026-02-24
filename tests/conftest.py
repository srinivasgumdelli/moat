"""Shared test fixtures."""

from __future__ import annotations

import pytest

from intel.config import load_config
from intel.db import get_connection, init_db
from intel.models import Article, Cluster, Summary


@pytest.fixture
def sample_config(tmp_path):
    """Minimal config for testing (no real API keys)."""
    config_text = """
llm:
  providers:
    mock:
      type: "openai_compatible"
      api_key: "test-key"
      base_url: "http://localhost:9999"
      default_model: "test-model"
  tasks:
    summarize: { provider: "mock" }
    label_clusters: { provider: "mock" }
    crossref: { provider: "mock" }
    projections: { provider: "mock" }

sources:
  rss:
    enabled: true
    feeds:
      tech:
        - url: "https://example.com/feed.xml"
          name: "Test Feed"

process:
  dedup:
    enabled: true
    cosine_threshold: 0.85
  cluster:
    enabled: true
    distance_threshold: 0.6
  embeddings:
    model: "minishlab/potion-base-8M"

analyze:
  crossref:
    enabled: false
  projections:
    enabled: false

deliver:
  telegram:
    enabled: false
    bot_token: "fake"
    chat_id: "fake"

pipeline:
  max_articles_per_topic: 10
  topics: [tech]

database:
  path: "DB_PATH_PLACEHOLDER"
"""
    db_path = str(tmp_path / "test.db")
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(config_text.replace("DB_PATH_PLACEHOLDER", db_path))
    return load_config(str(cfg_path))


@pytest.fixture
def db_conn(sample_config):
    """Initialized test database connection."""
    db_path = sample_config["database"]["path"]
    init_db(db_path)
    conn = get_connection(db_path)
    yield conn
    conn.close()


@pytest.fixture
def sample_articles():
    """List of sample articles for testing."""
    return [
        Article(
            url="https://example.com/article-1",
            title="AI Breakthrough in Language Models",
            content="Researchers have achieved a major breakthrough in language model efficiency. "
            "The new approach reduces compute requirements by 50% while maintaining quality.",
            source_name="Tech News",
            source_type="rss",
            topic="tech",
        ),
        Article(
            url="https://example.com/article-2",
            title="AI Breakthrough in Language Models",  # Same title, different URL
            content="Researchers have achieved a major breakthrough in language model efficiency. "
            "The new approach reduces compute requirements by 50% while maintaining quality.",
            source_name="Other Source",
            source_type="rss",
            topic="tech",
        ),
        Article(
            url="https://example.com/article-3",
            title="EU Proposes New Trade Agreement",
            content="The European Union has proposed a comprehensive trade agreement with "
            "Southeast Asian nations, aiming to reduce tariffs and boost economic ties.",
            source_name="World News",
            source_type="rss",
            topic="geopolitics",
        ),
        Article(
            url="https://example.com/article-4",
            title="Federal Reserve Signals Rate Change",
            content="The Federal Reserve indicated potential interest rate adjustments in "
            "the coming months, citing inflation concerns and labor market data.",
            source_name="Finance Daily",
            source_type="rss",
            topic="finance",
        ),
        Article(
            url="https://example.com/article-5",
            title="New AI Chip Announced by Startup",
            content="A Silicon Valley startup has announced a new AI accelerator chip "
            "that promises 10x performance improvement over current solutions.",
            source_name="Tech News",
            source_type="rss",
            topic="tech",
        ),
    ]


@pytest.fixture
def sample_clusters(sample_articles):
    """Sample clusters for testing."""
    return [
        Cluster(
            id=1,
            topic="tech",
            label="AI Language Model Advances",
            article_count=2,
            run_id=1,
            articles=sample_articles[:2],
        ),
        Cluster(
            id=2,
            topic="geopolitics",
            label="EU Trade Negotiations",
            article_count=1,
            run_id=1,
            articles=[sample_articles[2]],
        ),
    ]


@pytest.fixture
def sample_summaries():
    """Sample summaries for testing."""
    return [
        Summary(
            id=1,
            cluster_id=1,
            depth="briefing",
            what_happened="Researchers achieved a breakthrough in LLM efficiency.",
            why_it_matters="Could reduce AI compute costs significantly.",
            whats_next="Expect industry adoption within months.",
            confidence="confirmed",
            sources=["Tech News", "Other Source"],
        ),
        Summary(
            id=2,
            cluster_id=2,
            depth="briefing",
            what_happened="EU proposed trade deal with Southeast Asia.",
            why_it_matters="Signals EU pivot toward Asian economic partnerships.",
            whats_next="Watch for ASEAN member responses this week.",
            confidence="likely",
            sources=["World News"],
        ),
    ]
