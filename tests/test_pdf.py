"""Tests for PDF digest rendering."""

from __future__ import annotations

from intel.models import CrossReference, PipelineRun, Projection, Trend
from intel.synthesize.pdf import format_pdf_caption, render_pdf_digest


def test_render_pdf_basic(sample_clusters, sample_summaries):
    """PDF renders with basic cluster/summary data."""
    pdf_bytes = render_pdf_digest(sample_clusters, sample_summaries)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 100
    # Valid PDF header
    assert pdf_bytes[:5] == b"%PDF-"


def test_render_pdf_all_sections(sample_clusters, sample_summaries):
    """PDF renders with all optional sections present."""
    xrefs = [
        CrossReference(
            cluster_ids=[1, 2],
            ref_type="pattern",
            description="AI regulation parallels trade negotiations.",
            confidence=0.7,
        )
    ]
    projs = [
        Projection(
            topic="tech",
            description="Major AI companies will announce efficiency improvements.",
            timeframe="weeks",
            confidence="likely",
            supporting_evidence="Multiple breakthroughs reported.",
        )
    ]
    trends = [
        Trend(
            topic="tech",
            current_label="AI Efficiency Race",
            previous_label="AI Scaling Race",
            trend_type="escalating",
            description="Shift from scaling to efficiency.",
        )
    ]
    run = PipelineRun(
        articles_fetched=85,
        clusters_formed=45,
        llm_tokens_used=5000,
        llm_cost_usd=0.12,
    )

    pdf_bytes = render_pdf_digest(
        sample_clusters, sample_summaries,
        cross_refs=xrefs,
        projections=projs,
        run=run,
        trends=trends,
    )
    assert isinstance(pdf_bytes, bytes)
    assert pdf_bytes[:5] == b"%PDF-"
    # Should be larger than basic (has more sections)
    basic = render_pdf_digest(sample_clusters, sample_summaries)
    assert len(pdf_bytes) > len(basic)


def test_render_pdf_empty():
    """Empty input produces a valid PDF."""
    pdf_bytes = render_pdf_digest([], [])
    assert isinstance(pdf_bytes, bytes)
    assert pdf_bytes[:5] == b"%PDF-"


def test_caption_length(sample_clusters):
    """Caption stays under Telegram's 1024-char limit."""
    run = PipelineRun(llm_cost_usd=0.05)
    caption = format_pdf_caption(sample_clusters, run)
    assert len(caption) <= 1024
    assert "INTEL DIGEST" in caption
    assert "clusters" in caption


def test_caption_no_run(sample_clusters):
    """Caption works without a PipelineRun."""
    caption = format_pdf_caption(sample_clusters)
    assert "INTEL DIGEST" in caption
    assert "$" not in caption
