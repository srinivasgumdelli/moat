"""Tests for digest report formatting."""

from __future__ import annotations

from intel.models import CrossReference, Projection
from intel.synthesize.report import format_digest


def test_format_digest_basic(sample_clusters, sample_summaries):
    """Digest formats with expected sections."""
    digest = format_digest(sample_clusters, sample_summaries)
    assert "INTEL DIGEST" in digest
    assert "TECH & AI" in digest
    assert "GEOPOLITICS" in digest
    assert "CONFIRMED" in digest
    assert "LIKELY" in digest
    assert "2 articles" in digest or "3 articles" in digest


def test_format_digest_with_crossrefs(sample_clusters, sample_summaries):
    """Cross-references section appears when provided."""
    xrefs = [
        CrossReference(
            cluster_ids=[1, 2],
            ref_type="pattern",
            description="AI regulation parallels trade negotiations.",
            confidence=0.7,
        )
    ]
    digest = format_digest(sample_clusters, sample_summaries, cross_refs=xrefs)
    assert "CROSS-REFERENCES" in digest
    assert "PATTERN" in digest


def test_format_digest_with_projections(sample_clusters, sample_summaries):
    """Projections section appears when provided."""
    projs = [
        Projection(
            topic="tech",
            description="Major AI companies will announce efficiency improvements.",
            timeframe="weeks",
            confidence="likely",
            supporting_evidence="Multiple breakthroughs reported.",
        )
    ]
    digest = format_digest(sample_clusters, sample_summaries, projections=projs)
    assert "PROJECTIONS" in digest
    assert "LIKELY" in digest


def test_format_digest_empty():
    """Empty input produces minimal digest."""
    digest = format_digest([], [])
    assert "INTEL DIGEST" in digest
    assert "0 articles" in digest


def test_format_digest_custom_topic_config(sample_clusters, sample_summaries):
    """Digest uses custom topic labels and emoji from config."""
    config = {
        "pipeline": {
            "topics": ["tech", "geopolitics"],
            "topic_display": {
                "tech": {
                    "label": "TECHNOLOGY",
                    "emoji": "\U0001f916",
                    "color": [50, 50, 200],
                },
                "geopolitics": {
                    "label": "WORLD AFFAIRS",
                    "emoji": "\U0001f310",
                    "color": [200, 50, 50],
                },
            },
        },
    }
    digest = format_digest(sample_clusters, sample_summaries, config=config)
    assert "TECHNOLOGY" in digest
    assert "WORLD AFFAIRS" in digest
    # Default labels should NOT appear
    assert "TECH & AI" not in digest
    assert "GEOPOLITICS" not in digest
