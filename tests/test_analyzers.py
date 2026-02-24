"""Tests for analyzers (crossref, projections, trends)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from intel.analyze.crossref import CrossRefAnalyzer
from intel.analyze.projections import ProjectionsAnalyzer
from intel.analyze.trends import TrendsAnalyzer
from intel.llm.base import LLMResponse
from intel.models import Cluster, Summary, Trend


@pytest.fixture
def analyzer_config():
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
            "tasks": {
                "crossref": {"provider": "mock"},
                "projections": {"provider": "mock"},
            },
        },
        "analyze": {
            "crossref": {"enabled": True},
            "projections": {"enabled": True},
            "trends": {"enabled": True},
        },
        "database": {"path": "/tmp/test_analyzers.db"},
    }


@pytest.fixture
def clusters_and_summaries():
    clusters = [
        Cluster(
            id=1, topic="tech", label="AI Advances",
            article_count=3, run_id=1,
        ),
        Cluster(
            id=2, topic="geopolitics", label="Trade Tensions",
            article_count=2, run_id=1,
        ),
    ]
    summaries = [
        Summary(
            id=1, cluster_id=1, depth="briefing",
            what_happened="AI models improved.",
            why_it_matters="Cost reduction.",
            whats_next="Adoption expected.",
            confidence="confirmed",
            sources=["TechNews"],
        ),
        Summary(
            id=2, cluster_id=2, depth="briefing",
            what_happened="EU-China trade dispute.",
            why_it_matters="Economic impact.",
            whats_next="Negotiations next week.",
            confidence="likely",
            sources=["BBC"],
        ),
    ]
    return clusters, summaries


@pytest.mark.asyncio
@patch("intel.analyze.crossref.get_provider_for_task")
async def test_crossref_finds_connections(
    mock_get_provider, analyzer_config, clusters_and_summaries,
):
    """CrossRef analyzer returns parsed cross-references."""
    clusters, summaries = clusters_and_summaries

    mock_provider = AsyncMock()
    mock_provider.complete.return_value = LLMResponse(
        text=json.dumps({
            "cross_references": [{
                "cluster_ids": [1, 2],
                "ref_type": "implicit_connection",
                "description": "AI regulation affects trade.",
                "confidence": 0.7,
            }]
        }),
        input_tokens=100, output_tokens=50, model="test",
    )
    mock_get_provider.return_value = mock_provider

    analyzer = CrossRefAnalyzer(analyzer_config)
    results = await analyzer.analyze(clusters, summaries)

    assert len(results) == 1
    assert results[0].ref_type == "implicit_connection"
    assert results[0].confidence == 0.7


@pytest.mark.asyncio
@patch("intel.analyze.crossref.get_provider_for_task")
async def test_crossref_handles_bad_json(
    mock_get_provider, analyzer_config, clusters_and_summaries,
):
    """CrossRef returns empty on bad JSON."""
    clusters, summaries = clusters_and_summaries

    mock_provider = AsyncMock()
    mock_provider.complete.return_value = LLMResponse(
        text="not json", input_tokens=10,
        output_tokens=10, model="test",
    )
    mock_get_provider.return_value = mock_provider

    analyzer = CrossRefAnalyzer(analyzer_config)
    results = await analyzer.analyze(clusters, summaries)
    assert results == []


@pytest.mark.asyncio
async def test_crossref_disabled(analyzer_config, clusters_and_summaries):
    """Disabled crossref returns empty."""
    analyzer_config["analyze"]["crossref"]["enabled"] = False
    clusters, summaries = clusters_and_summaries

    analyzer = CrossRefAnalyzer(analyzer_config)
    results = await analyzer.analyze(clusters, summaries)
    assert results == []


@pytest.mark.asyncio
@patch("intel.analyze.projections.get_provider_for_task")
async def test_projections_generates_forecasts(
    mock_get_provider, analyzer_config, clusters_and_summaries,
):
    """Projections analyzer returns parsed projections."""
    clusters, summaries = clusters_and_summaries

    mock_provider = AsyncMock()
    mock_provider.complete.return_value = LLMResponse(
        text=json.dumps({
            "projections": [{
                "topic": "tech",
                "description": "AI costs will drop 30%.",
                "timeframe": "months",
                "confidence": "likely",
                "supporting_evidence": "Multiple breakthroughs.",
            }]
        }),
        input_tokens=100, output_tokens=50, model="test",
    )
    mock_get_provider.return_value = mock_provider

    analyzer = ProjectionsAnalyzer(analyzer_config)
    results = await analyzer.analyze(clusters, summaries)

    assert len(results) == 1
    assert results[0].topic == "tech"
    assert results[0].confidence == "likely"


@pytest.mark.asyncio
async def test_trends_no_previous_run(
    analyzer_config, clusters_and_summaries,
):
    """Trends returns empty when no previous run exists."""
    clusters, summaries = clusters_and_summaries

    with patch(
        "intel.analyze.trends.get_previous_run_id", return_value=None,
    ), patch("intel.analyze.trends.get_connection"):
        analyzer = TrendsAnalyzer(analyzer_config)
        results = await analyzer.analyze(clusters, summaries)
        assert results == []


@pytest.mark.asyncio
async def test_trends_detects_continuing_story(
    analyzer_config, clusters_and_summaries,
):
    """Trends detects a continuing story across runs."""
    clusters, summaries = clusters_and_summaries

    prev_clusters = [
        Cluster(
            id=10, topic="tech", label="AI Advances",
            article_count=2, run_id=0,
        ),
    ]
    prev_summaries = [
        Summary(
            id=10, cluster_id=10, depth="briefing",
            what_happened="AI models improved.",
            why_it_matters="Cost savings.",
            whats_next="More to come.",
            confidence="confirmed",
            sources=["TechNews"],
        ),
    ]
    prev_pairs = list(zip(prev_clusters, prev_summaries))

    with patch(
        "intel.analyze.trends.get_previous_run_id", return_value=0,
    ), patch(
        "intel.analyze.trends.get_clusters_with_summaries",
        return_value=prev_pairs,
    ), patch("intel.analyze.trends.get_connection"):
        analyzer = TrendsAnalyzer(analyzer_config)
        results = await analyzer.analyze(clusters, summaries)

        assert len(results) >= 1
        assert isinstance(results[0], Trend)
        assert results[0].trend_type == "continuing"
