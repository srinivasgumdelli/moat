"""Format the final digest as Markdown for delivery."""

from __future__ import annotations

from datetime import datetime

from intel.models import Cluster, CrossReference, PipelineRun, Projection, Summary

TOPIC_LABELS = {
    "tech": "TECH & AI",
    "geopolitics": "GEOPOLITICS",
    "finance": "FINANCE",
}

CONFIDENCE_ICONS = {
    "confirmed": "CONFIRMED",
    "likely": "LIKELY",
    "developing": "DEVELOPING",
    "speculative": "SPECULATIVE",
}


def format_digest(
    clusters: list[Cluster],
    summaries: list[Summary],
    cross_refs: list[CrossReference] | None = None,
    projections: list[Projection] | None = None,
    run: PipelineRun | None = None,
) -> str:
    """Format the complete intel digest as Markdown text."""
    now = datetime.utcnow()
    hour = now.hour
    period = "Morning" if hour < 12 else "Evening"
    date_str = now.strftime("%b %d, %Y")

    lines = [
        f"INTEL DIGEST — {date_str} ({period})",
        "━" * 32,
        "",
    ]

    # Group clusters and summaries by topic
    summary_map = {s.cluster_id: s for s in summaries}
    topic_clusters: dict[str, list[tuple[Cluster, Summary]]] = {}

    for cluster in clusters:
        summary = summary_map.get(cluster.id)
        if not summary:
            continue
        topic_clusters.setdefault(cluster.topic, []).append((cluster, summary))

    # Render each topic section
    counter = 1
    for topic in ["tech", "geopolitics", "finance"]:
        items = topic_clusters.get(topic, [])
        if not items:
            continue

        label = TOPIC_LABELS.get(topic, topic.upper())
        lines.append(label)
        lines.append("")

        for cluster, summary in items:
            conf = CONFIDENCE_ICONS.get(summary.confidence, summary.confidence.upper())
            sources_str = ", ".join(summary.sources[:4]) if summary.sources else "Multiple sources"

            lines.append(f"{counter}. [{conf}] {cluster.label}")
            lines.append(f"   What: {summary.what_happened}")
            lines.append(f"   Why: {summary.why_it_matters}")
            lines.append(f"   Next: {summary.whats_next}")
            lines.append(f"   (Sources: {sources_str})")
            lines.append("")
            counter += 1

    # Cross-references section
    if cross_refs:
        lines.append("CROSS-REFERENCES")
        lines.append("")
        for xref in cross_refs:
            type_label = xref.ref_type.upper().replace("_", " ")
            lines.append(f"- [{type_label}] {xref.description}")
        lines.append("")

    # Projections section
    if projections:
        lines.append("PROJECTIONS")
        lines.append("")
        for proj in projections:
            conf = proj.confidence.upper()
            lines.append(f"- [{conf}, {proj.timeframe}] {proj.description}")
        lines.append("")

    # Footer
    total_articles = sum(c.article_count for c in clusters)
    n_clusters = len(clusters)
    lines.append("━" * 32)

    footer_parts = [f"{total_articles} articles", f"{n_clusters} clusters"]
    if run and run.llm_cost_usd > 0:
        footer_parts.append(f"${run.llm_cost_usd:.2f}")
    lines.append(" | ".join(footer_parts))

    return "\n".join(lines)
