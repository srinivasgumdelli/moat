"""Tests for cluster summarization."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from intel.llm.base import LLMResponse
from intel.models import Article, Cluster
from intel.synthesize.summarizer import summarize_all_clusters, summarize_cluster


@pytest.fixture
def summarizer_config():
    return {
        "llm": {
            "providers": {
                "mock": {
                    "type": "openai_compatible",
                    "api_key": "test",
                    "base_url": "http://localhost:9999",
                    "default_model": "test",
                },
            },
            "tasks": {"summarize": {"provider": "mock"}},
        },
    }


def _make_cluster(n_articles=3, topic="tech"):
    articles = [
        Article(
            url=f"https://example.com/{i}",
            title=f"Article {i} about AI",
            content=f"Detailed content about article {i}. " * 20,
            source_name=f"Source {i}",
            source_type="rss",
            topic=topic,
        )
        for i in range(n_articles)
    ]
    return Cluster(
        id=1, topic=topic, label="Test Cluster",
        article_count=n_articles, run_id=1, articles=articles,
    )


def _llm_response(data: dict) -> LLMResponse:
    return LLMResponse(
        text=json.dumps(data), input_tokens=50,
        output_tokens=30, model="test",
    )


@pytest.mark.asyncio
@patch("intel.synthesize.summarizer.get_provider_for_task")
async def test_summarize_cluster_parses_json(
    mock_get_provider, summarizer_config,
):
    """Summarizer parses valid JSON from LLM."""
    mock_provider = AsyncMock()
    mock_provider.complete.return_value = _llm_response({
        "label": "AI Efficiency Breakthrough",
        "confidence": "confirmed",
        "what_happened": "Researchers improved efficiency.",
        "why_it_matters": "Reduces compute costs.",
        "whats_next": "Expect adoption soon.",
        "sources": ["Source 0", "Source 1"],
    })
    mock_get_provider.return_value = mock_provider

    cluster = _make_cluster(3)
    summary = await summarize_cluster(summarizer_config, cluster)

    assert summary.what_happened == "Researchers improved efficiency."
    assert summary.confidence == "confirmed"
    assert cluster.label == "AI Efficiency Breakthrough"


@pytest.mark.asyncio
@patch("intel.synthesize.summarizer.get_provider_for_task")
async def test_summarize_single_article(
    mock_get_provider, summarizer_config,
):
    """Single-article cluster uses single article prompt."""
    mock_provider = AsyncMock()
    mock_provider.complete.return_value = _llm_response({
        "confidence": "likely",
        "what_happened": "A single event occurred.",
        "why_it_matters": "Significant impact.",
        "whats_next": "Monitor closely.",
    })
    mock_get_provider.return_value = mock_provider

    cluster = _make_cluster(1)
    summary = await summarize_cluster(summarizer_config, cluster)

    assert summary.what_happened == "A single event occurred."
    assert len(summary.sources) == 1


@pytest.mark.asyncio
@patch("intel.synthesize.summarizer.get_provider_for_task")
async def test_summarize_handles_bad_json(
    mock_get_provider, summarizer_config,
):
    """Summarizer handles invalid JSON gracefully."""
    mock_provider = AsyncMock()
    mock_provider.complete.return_value = LLMResponse(
        text="This is not JSON at all",
        input_tokens=10, output_tokens=10, model="test",
    )
    mock_get_provider.return_value = mock_provider

    cluster = _make_cluster(2)
    summary = await summarize_cluster(summarizer_config, cluster)

    # Should still produce a summary using raw text
    assert "not JSON" in summary.what_happened
    assert summary.confidence == "developing"


@pytest.mark.asyncio
@patch("intel.synthesize.summarizer.get_provider_for_task")
async def test_summarize_all_clusters_handles_failure(
    mock_get_provider, summarizer_config,
):
    """summarize_all_clusters skips failed clusters."""
    call_count = 0

    async def side_effect(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise Exception("LLM error")
        return _llm_response({
            "confidence": "likely",
            "what_happened": "Event.",
            "why_it_matters": "Important.",
            "whats_next": "Watch.",
        })

    mock_provider = AsyncMock()
    mock_provider.complete.side_effect = side_effect
    mock_get_provider.return_value = mock_provider

    clusters = [_make_cluster(1), _make_cluster(1)]
    clusters[1].id = 2
    summaries = await summarize_all_clusters(
        summarizer_config, clusters,
    )

    # First fails, second succeeds
    assert len(summaries) == 1
