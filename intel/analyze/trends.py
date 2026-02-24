"""Trends analyzer — detects developing stories across pipeline runs."""

from __future__ import annotations

import logging
from typing import Any

from intel.analyze import register_analyzer
from intel.analyze.base import BaseAnalyzer
from intel.config import get_db_path
from intel.db import (
    get_clusters_with_summaries,
    get_connection,
    get_previous_run_id,
)
from intel.models import Cluster, Summary, Trend

logger = logging.getLogger(__name__)

# Similarity threshold for matching clusters across runs
MATCH_THRESHOLD = 0.55


@register_analyzer("trends")
class TrendsAnalyzer(BaseAnalyzer):
    """Detect developing stories by comparing clusters across runs."""

    @property
    def name(self) -> str:
        return "trends"

    async def analyze(
        self, clusters: list[Cluster], summaries: list[Summary],
    ) -> list[Any]:
        cfg = self.config.get("analyze", {}).get("trends", {})
        if not cfg.get("enabled", False):
            return []

        if not clusters or not summaries:
            return []

        # Find previous run
        current_run_id = clusters[0].run_id
        db_path = get_db_path(self.config)
        conn = get_connection(db_path)
        try:
            prev_run_id = get_previous_run_id(conn, current_run_id)
            if prev_run_id is None:
                logger.info("No previous run — skipping trends")
                return []

            prev_pairs = get_clusters_with_summaries(conn, prev_run_id)
        finally:
            conn.close()

        if not prev_pairs:
            return []

        # Build summary map for current run
        summary_map = {s.cluster_id: s for s in summaries}

        # Match current clusters to previous clusters by topic + label
        trends = []
        for cluster in clusters:
            current_summary = summary_map.get(cluster.id)
            if not current_summary:
                continue

            best_match = self._find_best_match(
                cluster, current_summary, prev_pairs,
            )
            if best_match:
                trends.append(best_match)

        logger.info("Detected %d developing stories", len(trends))
        return trends

    def _find_best_match(
        self,
        current: Cluster,
        current_summary: Summary,
        prev_pairs: list[tuple[Cluster, Summary | None]],
    ) -> Trend | None:
        """Find the best matching previous cluster for a current one."""
        best_score = 0.0
        best_prev_cluster = None
        best_prev_summary = None

        current_text = (
            f"{current.label} {current_summary.what_happened}"
        ).lower()
        current_words = set(current_text.split())

        for prev_cluster, prev_summary in prev_pairs:
            if prev_cluster.topic != current.topic:
                continue
            if prev_summary is None:
                continue

            prev_text = (
                f"{prev_cluster.label} {prev_summary.what_happened}"
            ).lower()
            prev_words = set(prev_text.split())

            # Jaccard similarity on words
            if not current_words or not prev_words:
                continue
            intersection = current_words & prev_words
            union = current_words | prev_words
            score = len(intersection) / len(union)

            if score > best_score:
                best_score = score
                best_prev_cluster = prev_cluster
                best_prev_summary = prev_summary

        if best_score < MATCH_THRESHOLD or not best_prev_cluster:
            return None

        # Determine trend type based on confidence changes
        trend_type = self._classify_trend(
            current_summary, best_prev_summary,
        )

        return Trend(
            topic=current.topic,
            current_label=current.label,
            previous_label=best_prev_cluster.label,
            trend_type=trend_type,
            description=(
                f"Story continues from previous run: "
                f"'{best_prev_cluster.label}' → '{current.label}'"
            ),
        )

    @staticmethod
    def _classify_trend(
        current: Summary, previous: Summary | None,
    ) -> str:
        """Classify whether a story is escalating or de-escalating."""
        if previous is None:
            return "continuing"

        confidence_order = [
            "speculative", "developing", "likely", "confirmed",
        ]
        try:
            curr_idx = confidence_order.index(current.confidence)
            prev_idx = confidence_order.index(previous.confidence)
        except ValueError:
            return "continuing"

        if curr_idx > prev_idx:
            return "escalating"
        elif curr_idx < prev_idx:
            return "de-escalating"
        return "continuing"
