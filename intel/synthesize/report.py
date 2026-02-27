"""Format the final digest as Telegram HTML for delivery."""

from __future__ import annotations

import re
from datetime import datetime
from html import escape

from intel.config import get_topic_display
from intel.models import (
    Cluster,
    CrossReference,
    PipelineRun,
    Projection,
    Summary,
    Trend,
)

CONFIDENCE_BADGE = {
    "confirmed": "\u2705 CONFIRMED",
    "likely": "\U0001f7e2 LIKELY",
    "developing": "\U0001f7e1 DEVELOPING",
    "speculative": "\U0001f7e0 SPECULATIVE",
}

TREND_BADGE = {
    "escalating": "\u2b06\ufe0f ESCALATING",
    "continuing": "\u27a1\ufe0f CONTINUING",
    "de-escalating": "\u2b07\ufe0f DE-ESCALATING",
}


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode entities from text."""
    clean = re.sub(r"<[^>]+>", "", text)
    clean = clean.replace("&nbsp;", " ").replace("&amp;", "&")
    clean = clean.replace("&lt;", "<").replace("&gt;", ">")
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


def _e(text: str) -> str:
    """Escape text for Telegram HTML."""
    return escape(str(text))


def format_digest(
    clusters: list[Cluster],
    summaries: list[Summary],
    cross_refs: list[CrossReference] | None = None,
    projections: list[Projection] | None = None,
    run: PipelineRun | None = None,
    trends: list[Trend] | None = None,
    config: dict | None = None,
) -> str:
    """Format the complete intel digest as Telegram HTML."""
    topic_display = get_topic_display(config or {})

    now = datetime.utcnow()
    period = "\U0001f305 Morning" if now.hour < 12 else "\U0001f307 Evening"
    date_str = now.strftime("%b %d, %Y")

    lines = [
        f"<b>\U0001f4e1 INTEL DIGEST</b> \u2014 {_e(date_str)} ({period})",
        "\u2500" * 28,
        "",
    ]

    # Group clusters and summaries by topic
    summary_map = {s.cluster_id: s for s in summaries}
    topic_clusters: dict[str, list[tuple[Cluster, Summary]]] = {}

    for cluster in clusters:
        summary = summary_map.get(cluster.id)
        if not summary:
            continue
        topic_clusters.setdefault(
            cluster.topic, [],
        ).append((cluster, summary))

    # Render each topic section
    counter = 1
    for topic, display in topic_display.items():
        items = topic_clusters.get(topic, [])
        if not items:
            continue

        emoji = display["emoji"]
        label = display["label"]
        lines.append(f"{emoji} <b>{label}</b>")
        lines.append("")

        for cluster, summary in items:
            badge = CONFIDENCE_BADGE.get(
                summary.confidence, summary.confidence.upper(),
            )
            sources_str = (
                ", ".join(summary.sources[:4])
                if summary.sources
                else "Multiple sources"
            )

            lines.append(f"<b>{counter}.</b> [{badge}] <b>{_e(cluster.label)}</b>")
            lines.append(f"   \U0001f4cc <i>What:</i> {_e(summary.what_happened)}")
            lines.append(f"   \u2753 <i>Why:</i> {_e(summary.why_it_matters)}")
            lines.append(f"   \u27a1 <i>Next:</i> {_e(summary.whats_next)}")
            lines.append(f"   <i>({_e(sources_str)})</i>")
            lines.append("")
            counter += 1

    # Source-specific sections
    _source_sections = [
        ("reddit", "\U0001f534 REDDIT PULSE"),   # 🔴
        ("xcom", "\U0001f535 X.COM PULSE"),       # 🔵
        ("hackernews", "\U0001f7e0 HACKER NEWS PULSE"),
        ("lemmy", "\U0001f7e2 LEMMY PULSE"),
        ("bluesky", "\U0001f4a0 BLUESKY PULSE"),
    ]
    for src_type, src_heading in _source_sections:
        src_items = []
        for cluster in clusters:
            summary = summary_map.get(cluster.id)
            if not summary:
                continue
            if any(a.source_type == src_type for a in (cluster.articles or [])):
                src_items.append((cluster, summary))
        if not src_items:
            continue

        lines.append(f"<b>{src_heading}</b>")
        lines.append("")

        src_counter = 1
        for cluster, summary in src_items:
            badge = CONFIDENCE_BADGE.get(
                summary.confidence, summary.confidence.upper(),
            )
            sources_str = (
                ", ".join(summary.sources[:4])
                if summary.sources
                else "Multiple sources"
            )

            lines.append(f"<b>{src_counter}.</b> [{badge}] <b>{_e(cluster.label)}</b>")
            lines.append(f"   \U0001f4cc <i>What:</i> {_e(summary.what_happened)}")
            lines.append(f"   \u2753 <i>Why:</i> {_e(summary.why_it_matters)}")
            lines.append(f"   \u27a1 <i>Next:</i> {_e(summary.whats_next)}")
            lines.append(f"   <i>({_e(sources_str)})</i>")
            lines.append("")
            src_counter += 1

    # Developing stories section
    if trends:
        lines.append("\U0001f4f0 <b>DEVELOPING STORIES</b>")
        lines.append("")
        for trend in trends:
            badge = TREND_BADGE.get(trend.trend_type, trend.trend_type)
            lines.append(f"\u2022 [{badge}] {_e(trend.current_label)}")
            if trend.previous_label != trend.current_label:
                lines.append(f"  <i>Previously: {_e(trend.previous_label)}</i>")
        lines.append("")

    # Cross-references section
    if cross_refs:
        lines.append("\U0001f517 <b>CROSS-REFERENCES</b>")
        lines.append("")
        for xref in cross_refs:
            type_label = xref.ref_type.upper().replace("_", " ")
            lines.append(f"\u2022 <b>[{_e(type_label)}]</b> {_e(xref.description)}")
        lines.append("")

    # Projections section
    if projections:
        lines.append("\U0001f52e <b>PROJECTIONS</b>")
        lines.append("")
        for proj in projections:
            conf = proj.confidence.upper()
            lines.append(
                f"\u2022 <b>[{_e(conf)}, {_e(proj.timeframe)}]</b> {_e(proj.description)}",
            )
        lines.append("")

    # Footer
    total_articles = sum(c.article_count for c in clusters)
    n_clusters = len(clusters)
    lines.append("\u2500" * 28)

    footer_parts = [
        f"{total_articles} articles",
        f"{n_clusters} clusters",
    ]
    if run and run.llm_cost_usd > 0:
        footer_parts.append(f"${run.llm_cost_usd:.2f}")
    lines.append(f"<i>{' | '.join(footer_parts)}</i>")

    return "\n".join(lines)


def format_fallback_digest(
    articles: list,
    run: PipelineRun | None = None,
    config: dict | None = None,
) -> str:
    """Format a raw article list when LLM summarization fails."""
    topic_display = get_topic_display(config or {})

    now = datetime.utcnow()
    period = "\U0001f305 Morning" if now.hour < 12 else "\U0001f307 Evening"
    date_str = now.strftime("%b %d, %Y")

    lines = [
        f"<b>\U0001f4e1 INTEL DIGEST</b> \u2014 {_e(date_str)} ({period})",
        "\u2500" * 28,
        "",
        "\u26a0\ufe0f <i>LLM unavailable \u2014 raw article list below.</i>",
        "",
    ]

    topic_articles: dict[str, list] = {}
    for article in articles:
        topic_articles.setdefault(article.topic, []).append(article)

    counter = 1
    for topic, display in topic_display.items():
        items = topic_articles.get(topic, [])
        if not items:
            continue

        emoji = display["emoji"]
        label = display["label"]
        lines.append(f"{emoji} <b>{label}</b>")
        lines.append("")

        for article in items[:15]:
            title = _e(_strip_html(article.title))
            source = _e(article.source_name)
            lines.append(f"<b>{counter}.</b> {title}")
            lines.append(f"   <i>{source}</i>")
            if article.content and len(article.content) > 50:
                snippet = _strip_html(article.content)[:120]
                lines.append(f"   {_e(snippet)}...")
            lines.append("")
            counter += 1

    lines.append("\u2500" * 28)
    footer_parts = [f"{len(articles)} articles", "fallback mode"]
    if run and run.llm_cost_usd > 0:
        footer_parts.append(f"${run.llm_cost_usd:.2f}")
    lines.append(f"<i>{' | '.join(footer_parts)}</i>")

    return "\n".join(lines)
