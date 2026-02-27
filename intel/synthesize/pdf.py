"""Render the intel digest as a styled PDF."""

from __future__ import annotations

import io
import logging
import os
from datetime import datetime

from fpdf import FPDF

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

# Colors (R, G, B)
NAVY = (20, 33, 61)
WHITE = (255, 255, 255)
LIGHT_GRAY = (245, 245, 245)
DARK_GRAY = (80, 80, 80)

CONFIDENCE_LABEL = {
    "confirmed": "CONFIRMED",
    "likely": "LIKELY",
    "developing": "DEVELOPING",
    "speculative": "SPECULATIVE",
}

CONFIDENCE_COLOR = {
    "confirmed": (34, 139, 34),
    "likely": (0, 128, 0),
    "developing": (204, 153, 0),
    "speculative": (204, 102, 0),
}

TREND_LABEL = {
    "escalating": "ESCALATING",
    "continuing": "CONTINUING",
    "de-escalating": "DE-ESCALATING",
}

# Common DejaVuSans paths across distros
_DEJAVU_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
]

_DEJAVU_BOLD_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def _find_font(paths: list[str]) -> str | None:
    for p in paths:
        if os.path.isfile(p):
            return p
    return None


# Unicode → latin-1-safe replacements for Helvetica fallback
_LATIN1_MAP = str.maketrans({
    "\u2014": "--",   # em dash
    "\u2013": "-",    # en dash
    "\u2018": "'",    # left single quote
    "\u2019": "'",    # right single quote
    "\u201c": '"',    # left double quote
    "\u201d": '"',    # right double quote
    "\u2026": "...",  # ellipsis
    "\u2022": "*",    # bullet
    "\u2032": "'",    # prime
    "\u2033": '"',    # double prime
    "\u00a0": " ",    # non-breaking space
})


def _safe_text(text: str, use_ttf: bool) -> str:
    """Sanitize text for the active font encoding."""
    if use_ttf:
        return text
    # Helvetica is latin-1 only — replace known Unicode chars
    result = text.translate(_LATIN1_MAP)
    # Drop any remaining non-latin-1 characters
    return result.encode("latin-1", errors="replace").decode("latin-1")


class DigestPDF(FPDF):
    """Custom PDF with styled header and footer for the intel digest."""

    def __init__(self, date_str: str, period: str):
        super().__init__()
        self.date_str = date_str
        self.period = period
        self._use_ttf = False

        # Try to load DejaVuSans for better Unicode support
        regular = _find_font(_DEJAVU_PATHS)
        bold = _find_font(_DEJAVU_BOLD_PATHS)
        if regular and bold:
            self.add_font("DejaVu", "", regular)
            self.add_font("DejaVu", "B", bold)
            self._use_ttf = True
            self._font_family = "DejaVu"
        else:
            self._font_family = "Helvetica"

    @property
    def font_name(self) -> str:
        return self._font_family

    def _t(self, text: str) -> str:
        """Sanitize text for the active font encoding."""
        return _safe_text(text, self._use_ttf)

    def header(self):
        # Navy header bar
        self.set_fill_color(*NAVY)
        self.rect(0, 0, self.w, 22, "F")

        self.set_font(self.font_name, "B", 14)
        self.set_text_color(*WHITE)
        self.set_y(5)
        self.cell(0, 12, self._t(f"INTEL DIGEST  --  {self.date_str} ({self.period})"), align="C")
        self.ln(20)

    def footer(self):
        self.set_y(-15)
        self.set_font(self.font_name, "", 8)
        self.set_text_color(*DARK_GRAY)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    def section_heading(self, title: str, color: tuple[int, int, int]):
        """Render a colored section heading."""
        self.set_font(self.font_name, "B", 12)
        self.set_text_color(*color)
        self.cell(0, 10, self._t(title))
        self.ln(8)
        # Underline
        self.set_draw_color(*color)
        self.set_line_width(0.5)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(4)

    def story_block(
        self,
        number: int,
        label: str,
        confidence: str,
        what: str,
        why: str,
        next_step: str,
        sources: str,
    ):
        """Render a single story/cluster summary block."""
        self.set_fill_color(*LIGHT_GRAY)

        # Title line with number and confidence badge
        badge = CONFIDENCE_LABEL.get(confidence, confidence.upper())
        badge_color = CONFIDENCE_COLOR.get(confidence, DARK_GRAY)

        self.set_font(self.font_name, "B", 10)
        self.set_text_color(*NAVY)
        title_text = f"{number}. {label}"
        self.cell(0, 7, self._t(title_text))
        self.ln(6)

        # Confidence badge
        self.set_font(self.font_name, "B", 8)
        self.set_text_color(*badge_color)
        self.cell(0, 5, self._t(f"[{badge}]"))
        self.ln(5)

        # What / Why / Next
        left_indent = self.l_margin + 4
        body_width = self.w - left_indent - self.r_margin

        for field_label, field_text in [
            ("What:", what),
            ("Why:", why),
            ("Next:", next_step),
        ]:
            self.set_x(left_indent)
            self.set_font(self.font_name, "B", 9)
            self.set_text_color(*DARK_GRAY)
            self.cell(14, 5, self._t(field_label))
            self.set_font(self.font_name, "", 9)
            self.set_text_color(0, 0, 0)
            self.multi_cell(body_width - 14, 5, self._t(field_text))

        # Sources
        self.set_x(left_indent)
        self.set_font(self.font_name, "", 8)
        self.set_text_color(*DARK_GRAY)
        self.cell(0, 5, self._t(f"Sources: {sources}"))
        self.ln(4)

        self.ln(3)

    def bullet_item(self, text: str, bold_prefix: str = ""):
        """Render a bullet point item."""
        self.set_x(self.l_margin + 4)
        self.set_font(self.font_name, "", 9)
        self.set_text_color(0, 0, 0)
        bullet_width = self.w - self.l_margin - 4 - self.r_margin
        if bold_prefix:
            safe_prefix = self._t(bold_prefix)
            self.set_font(self.font_name, "B", 9)
            self.cell(self.get_string_width(safe_prefix) + 2, 5, safe_prefix)
            self.set_font(self.font_name, "", 9)
            remaining = bullet_width - self.get_string_width(safe_prefix) - 2
            self.multi_cell(remaining, 5, self._t(text))
        else:
            self.multi_cell(bullet_width, 5, self._t(f"- {text}"))


def render_pdf_digest(
    clusters: list[Cluster],
    summaries: list[Summary],
    cross_refs: list[CrossReference] | None = None,
    projections: list[Projection] | None = None,
    run: PipelineRun | None = None,
    trends: list[Trend] | None = None,
    config: dict | None = None,
) -> bytes:
    """Render the intel digest as a styled PDF. Returns raw PDF bytes."""
    topic_display = get_topic_display(config or {})

    now = datetime.utcnow()
    period = "Morning" if now.hour < 12 else "Evening"
    date_str = now.strftime("%b %d, %Y")

    pdf = DigestPDF(date_str, period)
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

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
    for topic, display in topic_display.items():
        items = topic_clusters.get(topic, [])
        if not items:
            continue

        color = tuple(display["color"])
        label = display["label"]
        pdf.section_heading(label, color)

        for cluster, summary in items:
            sources_str = (
                ", ".join(summary.sources[:4])
                if summary.sources
                else "Multiple sources"
            )
            pdf.story_block(
                number=counter,
                label=cluster.label,
                confidence=summary.confidence,
                what=summary.what_happened,
                why=summary.why_it_matters,
                next_step=summary.whats_next,
                sources=sources_str,
            )
            counter += 1

    # Developing stories
    if trends:
        pdf.section_heading("DEVELOPING STORIES", NAVY)
        for trend in trends:
            badge = TREND_LABEL.get(trend.trend_type, trend.trend_type.upper())
            text = f"{trend.current_label}"
            if trend.previous_label != trend.current_label:
                text += f" (previously: {trend.previous_label})"
            pdf.bullet_item(text, bold_prefix=f"[{badge}] ")

    # Cross-references
    if cross_refs:
        pdf.section_heading("CROSS-REFERENCES", NAVY)
        for xref in cross_refs:
            type_label = xref.ref_type.upper().replace("_", " ")
            pdf.bullet_item(xref.description, bold_prefix=f"[{type_label}] ")

    # Projections
    if projections:
        pdf.section_heading("PROJECTIONS", NAVY)
        for proj in projections:
            conf = proj.confidence.upper()
            pdf.bullet_item(
                proj.description,
                bold_prefix=f"[{conf}, {proj.timeframe}] ",
            )

    # Footer stats
    total_articles = sum(c.article_count for c in clusters)
    n_clusters = len(clusters)
    pdf.ln(5)
    pdf.set_draw_color(*NAVY)
    pdf.set_line_width(0.3)
    pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
    pdf.ln(3)

    footer_parts = [f"{total_articles} articles", f"{n_clusters} clusters"]
    if run and run.llm_cost_usd > 0:
        footer_parts.append(f"${run.llm_cost_usd:.2f}")
    pdf.set_font(pdf.font_name, "", 9)
    pdf.set_text_color(*DARK_GRAY)
    pdf.cell(0, 6, " | ".join(footer_parts), align="C")

    buf = io.BytesIO()
    pdf.output(buf)
    return buf.getvalue()


def format_pdf_caption(
    clusters: list[Cluster],
    run: PipelineRun | None = None,
    config: dict | None = None,
) -> str:
    """Short summary for Telegram caption (under 1024 chars)."""
    topic_display = get_topic_display(config or {})

    now = datetime.utcnow()
    period = "Morning" if now.hour < 12 else "Evening"
    date_str = now.strftime("%b %d, %Y")

    total_articles = sum(c.article_count for c in clusters)
    n_clusters = len(clusters)

    # Count clusters per topic
    topic_counts: dict[str, int] = {}
    for c in clusters:
        topic_counts[c.topic] = topic_counts.get(c.topic, 0) + 1

    topic_parts = []
    for topic, display in topic_display.items():
        count = topic_counts.get(topic, 0)
        if count:
            topic_parts.append(f"{count} {display['label'].lower()}")

    caption = (
        f"INTEL DIGEST -- {date_str} ({period})\n"
        f"{total_articles} articles, {n_clusters} clusters"
    )
    if topic_parts:
        caption += f" ({', '.join(topic_parts)})"
    if run and run.llm_cost_usd > 0:
        caption += f" | ${run.llm_cost_usd:.2f}"

    return caption[:1024]
