"""Tests for pipeline orchestration."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from intel.models import Article


class FakeEntry(dict):
    """Dict subclass that also supports attribute access (like feedparser)."""

    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


@pytest.fixture
def pipeline_config(tmp_path):
    """Config for pipeline tests with all analysis disabled."""
    from intel.config import load_config

    db_path = str(tmp_path / "test.db")
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        """
llm:
  providers:
    mock:
      type: "openai_compatible"
      api_key: "test"
      base_url: "http://localhost:9999"
      default_model: "test-model"
  tasks:
    summarize:
      provider: "mock"
    label_clusters:
      provider: "mock"
    crossref:
      provider: "mock"
    projections:
      provider: "mock"

sources:
  rss:
    enabled: true
    feeds:
      tech:
        - url: "https://example.com/feed.xml"
          name: "Test Feed"

process:
  dedup:
    enabled: false
  cluster:
    enabled: false
  embeddings:
    model: "minishlab/potion-base-8M"

analyze:
  crossref:
    enabled: false
  projections:
    enabled: false
  trends:
    enabled: false

deliver:
  telegram:
    enabled: false

pipeline:
  max_articles_per_topic: 10
  max_article_age_hours: 48
  topics: [tech]

database:
  path: "DB_PATH"
""".replace("DB_PATH", db_path)
    )
    return load_config(str(cfg_path))


def _make_articles(n=3):
    return [
        Article(
            url=f"https://example.com/article-{i}",
            title=f"Test Article {i}",
            content=f"Content for test article {i} with enough text.",
            source_name="Test Feed",
            source_type="rss",
            topic="tech",
        )
        for i in range(n)
    ]


def _mock_llm_response(text):
    from intel.llm.base import LLMResponse

    return LLMResponse(text=text, input_tokens=10, output_tokens=20, model="test")


@pytest.mark.asyncio
@patch("intel.ingest.rss.feedparser")
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
@patch("intel.llm.openai_compat.httpx.AsyncClient")
async def test_pipeline_end_to_end(
    mock_httpx, mock_extract, mock_fp, pipeline_config,
):
    """Pipeline runs end-to-end with mocked sources and LLM."""
    from intel.db import get_connection, get_recent_runs, init_db
    from intel.pipeline import run_pipeline

    # Mock RSS feed
    entries = []
    for i in range(3):
        entries.append(FakeEntry(
            title=f"Article {i}",
            link=f"https://example.com/{i}",
            summary=f"Summary content for article {i} " * 10,
        ))
    mock_fp.parse.return_value = type("Feed", (), {"entries": entries})()
    mock_extract.return_value = None

    # Mock LLM response
    summary_json = json.dumps({
        "confidence": "confirmed",
        "what_happened": "Test event happened.",
        "why_it_matters": "It matters for testing.",
        "whats_next": "More tests expected.",
    })
    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": summary_json}}],
        "usage": {"prompt_tokens": 50, "completion_tokens": 30},
    }
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_httpx.return_value = mock_client

    db_path = pipeline_config["database"]["path"]
    init_db(db_path)

    await run_pipeline(pipeline_config)

    # Verify run was recorded
    conn = get_connection(db_path)
    runs = get_recent_runs(conn, limit=1)
    conn.close()

    assert len(runs) == 1
    assert runs[0]["status"] == "completed"
    assert runs[0]["articles_fetched"] == 3


@pytest.mark.asyncio
@patch("intel.ingest.rss.feedparser")
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
async def test_pipeline_no_articles(
    mock_extract, mock_fp, pipeline_config,
):
    """Pipeline completes gracefully with no articles."""
    from intel.db import get_connection, get_recent_runs, init_db
    from intel.pipeline import run_pipeline

    mock_fp.parse.return_value = type("Feed", (), {"entries": []})()

    db_path = pipeline_config["database"]["path"]
    init_db(db_path)

    await run_pipeline(pipeline_config)

    conn = get_connection(db_path)
    runs = get_recent_runs(conn, limit=1)
    conn.close()

    assert runs[0]["status"] == "completed"
    assert runs[0]["articles_fetched"] == 0


@pytest.mark.asyncio
@patch("intel.ingest.rss.feedparser")
@patch("intel.ingest.rss.extract_content", new_callable=AsyncMock)
@patch("intel.llm.openai_compat.httpx.AsyncClient")
async def test_pipeline_fallback_on_llm_failure(
    mock_httpx, mock_extract, mock_fp, pipeline_config,
):
    """Pipeline uses fallback digest when LLM fails."""
    from intel.db import init_db
    from intel.pipeline import run_pipeline

    # Mock RSS with articles
    entries = [FakeEntry(
        title="Test Article",
        link="https://example.com/1",
        summary="Content " * 30,
    )]
    mock_fp.parse.return_value = type("Feed", (), {"entries": entries})()
    mock_extract.return_value = None

    # Mock LLM to fail
    mock_client = AsyncMock()
    mock_client.post.side_effect = Exception("LLM down")
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_httpx.return_value = mock_client

    db_path = pipeline_config["database"]["path"]
    init_db(db_path)

    # Should not raise — fallback digest should be generated
    await run_pipeline(pipeline_config)
