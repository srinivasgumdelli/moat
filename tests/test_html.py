"""Tests for HTML digest rendering."""

from __future__ import annotations

from intel.models import CrossReference, PipelineRun, Projection, Summary, Trend
from intel.synthesize.html import render_html_digest


def test_render_html_basic(sample_clusters, sample_summaries):
    """HTML renders with basic cluster/summary data."""
    html = render_html_digest(sample_clusters, sample_summaries)
    assert isinstance(html, str)
    assert "<!DOCTYPE html>" in html
    assert "INTEL DIGEST" in html
    assert "AI Language Model Advances" in html
    assert "EU Trade Negotiations" in html


def test_render_html_all_sections(sample_clusters, sample_summaries):
    """HTML renders with all optional sections present."""
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

    html = render_html_digest(
        sample_clusters, sample_summaries,
        cross_refs=xrefs,
        projections=projs,
        run=run,
        trends=trends,
    )
    assert "CROSS-REFERENCES" in html
    assert "PROJECTIONS" in html
    assert "DEVELOPING STORIES" in html
    assert "Patterns" in html
    assert "AI regulation parallels" in html
    assert "ESCALATING" in html
    assert "AI Efficiency Race" in html
    assert "Previously: AI Scaling Race" in html
    assert "$0.12" in html


def test_render_html_empty():
    """Empty input produces valid HTML."""
    html = render_html_digest([], [])
    assert isinstance(html, str)
    assert "<!DOCTYPE html>" in html
    assert "0 articles" in html
    assert "0 clusters" in html


def test_render_html_xss_escaping(sample_clusters):
    """HTML escapes potentially dangerous content."""
    summaries = [
        Summary(
            id=1,
            cluster_id=1,
            depth="briefing",
            what_happened='<script>alert("xss")</script>',
            why_it_matters="It's a <b>big</b> deal & important",
            whats_next="Watch for <img src=x onerror=alert(1)>",
            confidence="confirmed",
            sources=["Tech News"],
        ),
    ]
    html = render_html_digest(sample_clusters, summaries)
    # The injected XSS must be escaped (the template's own <script> for TG SDK is fine)
    assert '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;' in html
    assert "&lt;img" in html
    assert "&amp; important" in html


def test_render_html_custom_topic_config(sample_clusters, sample_summaries):
    """HTML renders with custom topic display config."""
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
    html = render_html_digest(
        sample_clusters, sample_summaries, config=config,
    )
    assert "TECHNOLOGY" in html
    assert "WORLD AFFAIRS" in html
    assert "rgb(50, 50, 200)" in html
    assert "rgb(200, 50, 50)" in html


def test_render_html_confidence_badges(sample_clusters, sample_summaries):
    """HTML includes confidence badges."""
    html = render_html_digest(sample_clusters, sample_summaries)
    assert "CONFIRMED" in html
    assert "LIKELY" in html


def test_render_html_contains_telegram_webapp_sdk():
    """HTML includes Telegram WebApp JS SDK."""
    html = render_html_digest([], [])
    assert "telegram-web-app.js" in html
    assert "Telegram.WebApp" in html


def test_render_html_dark_mode_support():
    """HTML includes dark mode CSS."""
    html = render_html_digest([], [])
    assert "prefers-color-scheme: dark" in html


def test_render_html_collapsible_sections(sample_clusters, sample_summaries):
    """HTML uses details/summary for collapsible topic sections."""
    html = render_html_digest(sample_clusters, sample_summaries)
    assert "<details" in html
    assert "<summary" in html
