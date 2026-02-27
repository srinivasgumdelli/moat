"""Render the intel digest as a self-contained HTML page for Telegram Mini App."""

from __future__ import annotations

import html
import logging
from datetime import datetime

from intel.config import get_topic_display
from intel.models import (
    Cluster,
    CrossReference,
    PipelineRun,
    Projection,
    Summary,
    Trend,
)

logger = logging.getLogger(__name__)

CONFIDENCE_LABEL = {
    "confirmed": "CONFIRMED",
    "likely": "LIKELY",
    "developing": "DEVELOPING",
    "speculative": "SPECULATIVE",
}

CONFIDENCE_COLOR = {
    "confirmed": "#228B22",
    "likely": "#008000",
    "developing": "#CC9900",
    "speculative": "#CC6600",
}

TREND_LABEL = {
    "escalating": "ESCALATING",
    "continuing": "CONTINUING",
    "de-escalating": "DE-ESCALATING",
}

# Same grouping order as pdf.py
_XREF_TYPE_ORDER = [
    ("pattern", "Patterns"),
    ("implicit_connection", "Implicit Connections"),
    ("contradiction", "Contradictions"),
]

_PROJ_CONFIDENCE_ORDER = [
    ("likely", "Likely"),
    ("possible", "Possible"),
    ("speculative", "Speculative"),
]


def _e(text: str) -> str:
    """Escape text for safe HTML output."""
    return html.escape(text, quote=True)


def _topic_css_color(color: list[int]) -> str:
    """Convert [r, g, b] list to CSS rgb() string."""
    r, g, b = color[:3]
    return f"rgb({r}, {g}, {b})"


def _build_source_links(cluster: Cluster, summary: Summary) -> str:
    """Build source links HTML from cluster articles.

    Uses article URLs for clickable links, falls back to plain text
    source names if no articles are attached to the cluster.
    """
    articles = cluster.articles or []
    if not articles:
        # Fallback to plain source names from summary
        if summary.sources:
            return "Sources: " + _e(", ".join(summary.sources[:4]))
        return "Sources: Multiple sources"

    # Deduplicate by source_name, keep first URL per source
    seen: dict[str, str] = {}
    for article in articles:
        if article.source_name not in seen:
            seen[article.source_name] = article.url

    links = []
    for name, url in list(seen.items())[:4]:
        links.append(
            f'<a href="{_e(url)}" target="_blank" rel="noopener">'
            f'{_e(name)}</a>'
        )
    return "Sources: " + ", ".join(links)


def render_html_digest(
    clusters: list[Cluster],
    summaries: list[Summary],
    cross_refs: list[CrossReference] | None = None,
    projections: list[Projection] | None = None,
    run: PipelineRun | None = None,
    trends: list[Trend] | None = None,
    config: dict | None = None,
) -> str:
    """Render the intel digest as a self-contained HTML string.

    Same signature as render_pdf_digest(). Returns an HTML string with all
    CSS/JS inline, suitable for Telegram Mini App webview.
    """
    topic_display = get_topic_display(config or {})

    now = datetime.utcnow()
    period = "Morning" if now.hour < 12 else "Evening"
    date_str = now.strftime("%b %d, %Y")

    # Group clusters and summaries by topic
    summary_map = {s.cluster_id: s for s in summaries}
    topic_clusters: dict[str, list[tuple[Cluster, Summary]]] = {}

    for cluster in clusters:
        summary = summary_map.get(cluster.id)
        if not summary:
            continue
        topic_clusters.setdefault(cluster.topic, []).append((cluster, summary))

    # Build sections
    sections_html = []
    counter = 1

    for topic, display in topic_display.items():
        items = topic_clusters.get(topic, [])
        if not items:
            continue

        color = _topic_css_color(display["color"])
        label = _e(display["label"])

        cards_html = []
        for cluster, summary in items:
            badge = CONFIDENCE_LABEL.get(summary.confidence, summary.confidence.upper())
            badge_color = CONFIDENCE_COLOR.get(summary.confidence, "#505050")

            # Build source links from cluster articles
            source_links = _build_source_links(cluster, summary)

            cards_html.append(
                f'<div class="story-card">'
                f'<div class="story-header">'
                f'<span class="story-number">{counter}.</span> '
                f'<span class="story-title">{_e(cluster.label)}</span>'
                f'<span class="badge" style="background:{badge_color}">{_e(badge)}</span>'
                f'</div>'
                f'<div class="story-fields">'
                f'<div class="field"><span class="field-label">What:</span> '
                f'{_e(summary.what_happened)}</div>'
                f'<div class="field"><span class="field-label">Why:</span> '
                f'{_e(summary.why_it_matters)}</div>'
                f'<div class="field"><span class="field-label">Next:</span> '
                f'{_e(summary.whats_next)}</div>'
                f'</div>'
                f'<div class="sources">{source_links}</div>'
                f'</div>'
            )
            counter += 1

        sections_html.append(
            f'<details class="topic-section" open>'
            f'<summary class="topic-heading" style="border-color:{color}">'
            f'<span style="color:{color}">{label}</span>'
            f'</summary>'
            f'{"".join(cards_html)}'
            f'</details>'
        )

    # Source-specific sections (Reddit Pulse, X.com Pulse)
    _SOURCE_SECTIONS = [
        ("reddit", "REDDIT PULSE", "#FF4500"),
        ("xcom", "X.COM PULSE", "#1DA1F2"),
    ]

    for src_type, src_label, src_color in _SOURCE_SECTIONS:
        # Find clusters that have at least one article from this source
        src_items = []
        for cluster in clusters:
            summary = summary_map.get(cluster.id)
            if not summary:
                continue
            if any(a.source_type == src_type for a in (cluster.articles or [])):
                src_items.append((cluster, summary))
        if not src_items:
            continue

        src_counter = 1
        cards_html = []
        for cluster, summary in src_items:
            badge = CONFIDENCE_LABEL.get(summary.confidence, summary.confidence.upper())
            badge_color = CONFIDENCE_COLOR.get(summary.confidence, "#505050")
            source_links = _build_source_links(cluster, summary)

            cards_html.append(
                f'<div class="story-card">'
                f'<div class="story-header">'
                f'<span class="story-number">{src_counter}.</span> '
                f'<span class="story-title">{_e(cluster.label)}</span>'
                f'<span class="badge" style="background:{badge_color}">{_e(badge)}</span>'
                f'</div>'
                f'<div class="story-fields">'
                f'<div class="field"><span class="field-label">What:</span> '
                f'{_e(summary.what_happened)}</div>'
                f'<div class="field"><span class="field-label">Why:</span> '
                f'{_e(summary.why_it_matters)}</div>'
                f'<div class="field"><span class="field-label">Next:</span> '
                f'{_e(summary.whats_next)}</div>'
                f'</div>'
                f'<div class="sources">{source_links}</div>'
                f'</div>'
            )
            src_counter += 1

        sections_html.append(
            f'<details class="topic-section" open>'
            f'<summary class="topic-heading" style="border-color:{src_color}">'
            f'<span style="color:{src_color}">{_e(src_label)}</span>'
            f'</summary>'
            f'{"".join(cards_html)}'
            f'</details>'
        )

    # Developing stories
    if trends:
        trend_cards = []
        for trend in trends:
            badge = TREND_LABEL.get(trend.trend_type, trend.trend_type.upper())
            badge_colors = {
                "ESCALATING": "#CC3333",
                "CONTINUING": "#CC9900",
                "DE-ESCALATING": "#228B22",
            }
            badge_bg = badge_colors.get(badge, "#505050")
            prev = ""
            if trend.previous_label != trend.current_label:
                prev = (
                    f'<div class="item-meta">Previously: '
                    f'{_e(trend.previous_label)}</div>'
                )
            trend_cards.append(
                f'<div class="item-card">'
                f'<div class="item-header">'
                f'<span class="badge" style="background:{badge_bg}">'
                f'{_e(badge)}</span>'
                f'<span class="item-title">{_e(trend.current_label)}</span>'
                f'</div>'
                f'{prev}'
                f'</div>'
            )
        sections_html.append(
            f'<details class="topic-section" open>'
            f'<summary class="topic-heading" style="border-color:#14213d">'
            f'<span style="color:#14213d">DEVELOPING STORIES</span>'
            f'</summary>'
            f'{"".join(trend_cards)}'
            f'</details>'
        )

    # Cross-references — grouped by type
    if cross_refs:
        xref_html_parts = []
        xref_by_type: dict[str, list[CrossReference]] = {}
        for xref in cross_refs:
            xref_by_type.setdefault(xref.ref_type, []).append(xref)
        for type_key, type_label in _XREF_TYPE_ORDER:
            group = xref_by_type.pop(type_key, [])
            if group:
                cards = "".join(
                    f'<div class="item-card">'
                    f'<div class="item-text">{_e(xref.description)}</div>'
                    f'</div>'
                    for xref in group
                )
                xref_html_parts.append(
                    f'<div class="group-label">{_e(type_label)}</div>'
                    f'{cards}'
                )
        # Remaining types
        for type_key, group in xref_by_type.items():
            type_label = type_key.replace("_", " ").title()
            cards = "".join(
                f'<div class="item-card">'
                f'<div class="item-text">{_e(xref.description)}</div>'
                f'</div>'
                for xref in group
            )
            xref_html_parts.append(
                f'<div class="group-label">{_e(type_label)}</div>'
                f'{cards}'
            )
        sections_html.append(
            f'<details class="topic-section" open>'
            f'<summary class="topic-heading" style="border-color:#14213d">'
            f'<span style="color:#14213d">CROSS-REFERENCES</span>'
            f'</summary>'
            f'{"".join(xref_html_parts)}'
            f'</details>'
        )

    # Projections — grouped by confidence
    if projections:
        proj_html_parts = []
        proj_by_conf: dict[str, list[Projection]] = {}
        for proj in projections:
            proj_by_conf.setdefault(proj.confidence, []).append(proj)
        for conf_key, conf_label in _PROJ_CONFIDENCE_ORDER:
            group = proj_by_conf.pop(conf_key, [])
            if group:
                cards = "".join(
                    f'<div class="item-card">'
                    f'<div class="item-header">'
                    f'<span class="badge" style="background:#505050">'
                    f'{_e(proj.timeframe)}</span>'
                    f'<span class="item-title">{_e(proj.description)}</span>'
                    f'</div>'
                    f'</div>'
                    for proj in group
                )
                proj_html_parts.append(
                    f'<div class="group-label">{_e(conf_label)}</div>'
                    f'{cards}'
                )
        # Remaining confidence levels
        for conf_key, group in proj_by_conf.items():
            cards = "".join(
                f'<div class="item-card">'
                f'<div class="item-header">'
                f'<span class="badge" style="background:#505050">'
                f'{_e(proj.timeframe)}</span>'
                f'<span class="item-title">{_e(proj.description)}</span>'
                f'</div>'
                f'</div>'
                for proj in group
            )
            proj_html_parts.append(
                f'<div class="group-label">{_e(conf_key.title())}</div>'
                f'{cards}'
            )
        sections_html.append(
            f'<details class="topic-section" open>'
            f'<summary class="topic-heading" style="border-color:#14213d">'
            f'<span style="color:#14213d">PROJECTIONS</span>'
            f'</summary>'
            f'{"".join(proj_html_parts)}'
            f'</details>'
        )

    # Footer stats
    total_articles = sum(c.article_count for c in clusters)
    n_clusters = len(clusters)
    footer_parts = [f"{total_articles} articles", f"{n_clusters} clusters"]
    if run and run.llm_cost_usd > 0:
        footer_parts.append(f"${run.llm_cost_usd:.2f}")
    footer_text = _e(" | ".join(footer_parts))

    body_content = "".join(sections_html)

    return _TEMPLATE.format(
        title=_e(f"Intel Digest — {date_str} ({period})"),
        header_text=_e(f"INTEL DIGEST  —  {date_str} ({period})"),
        body=body_content,
        footer=footer_text,
    )


_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, \
maximum-scale=1.0, user-scalable=no">
<title>{title}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {{
  --bg-color: #ffffff;
  --text-color: #1a1a1a;
  --card-bg: #f5f5f5;
  --card-border: #e0e0e0;
  --header-bg: #14213d;
  --header-text: #ffffff;
  --muted: #505050;
  --link-color: #0066cc;
  --divider: #14213d;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg-color: #1a1a1a;
    --text-color: #e5e5e5;
    --card-bg: #2a2a2a;
    --card-border: #3a3a3a;
    --header-bg: #14213d;
    --header-text: #ffffff;
    --muted: #999999;
    --link-color: #5b9bd5;
    --divider: #555555;
  }}
}}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text-color);
  background: var(--bg-color);
  padding: 0 12px 24px;
  -webkit-text-size-adjust: 100%;
}}
.header {{
  background: var(--header-bg);
  color: var(--header-text);
  text-align: center;
  padding: 16px 12px;
  margin: 0 -12px 16px;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.5px;
}}
.topic-section {{
  margin-bottom: 16px;
}}
.topic-heading {{
  font-size: 15px;
  font-weight: 700;
  padding: 8px 0;
  border-bottom: 2px solid;
  cursor: pointer;
  list-style: none;
  user-select: none;
}}
.topic-heading::-webkit-details-marker {{ display: none; }}
.topic-heading::before {{
  content: "\\25BC  ";
  font-size: 10px;
  vertical-align: middle;
}}
details:not([open]) > .topic-heading::before {{
  content: "\\25B6  ";
}}
.story-card {{
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 12px;
  margin: 10px 0;
}}
.story-header {{
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}}
.story-number {{
  font-weight: 700;
  color: var(--text-color);
}}
.story-title {{
  font-weight: 700;
  color: var(--text-color);
  flex: 1;
}}
.badge {{
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}}
.story-fields {{
  margin-bottom: 8px;
}}
.field {{
  font-size: 14px;
  margin-bottom: 4px;
}}
.field-label {{
  font-weight: 700;
}}
.sources {{
  font-size: 12px;
  color: var(--muted);
}}
.sources a {{
  color: var(--link-color);
  text-decoration: none;
}}
.sources a:hover {{
  text-decoration: underline;
}}
.item-card {{
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
}}
.item-header {{
  display: flex;
  align-items: baseline;
  gap: 8px;
}}
.item-title {{
  font-size: 14px;
  font-weight: 600;
  color: var(--text-color);
  flex: 1;
}}
.item-text {{
  font-size: 14px;
  color: var(--text-color);
  line-height: 1.5;
}}
.item-meta {{
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
}}
.group-label {{
  font-size: 12px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 14px 0 2px 4px;
}}
.footer {{
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid var(--divider);
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}}
</style>
</head>
<body>
<div class="header">{header_text}</div>
{body}
<div class="footer">{footer}</div>
<script>
(function() {{
  var tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  // Map Telegram theme to CSS variables
  var tp = tg.themeParams || {{}};
  var root = document.documentElement.style;
  if (tp.bg_color) root.setProperty('--bg-color', tp.bg_color);
  if (tp.text_color) root.setProperty('--text-color', tp.text_color);
  if (tp.secondary_bg_color) root.setProperty('--card-bg', tp.secondary_bg_color);
  if (tp.hint_color) root.setProperty('--muted', tp.hint_color);
}})();
</script>
</body>
</html>"""
