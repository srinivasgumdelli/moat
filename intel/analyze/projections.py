"""Projections analyzer — generates near-term forecasts from digest."""

from __future__ import annotations

import json
import logging
from typing import Any

from intel.analyze import register_analyzer
from intel.analyze.base import BaseAnalyzer
from intel.llm import get_provider_for_task
from intel.llm.prompts import PROJECTIONS, SYSTEM_ANALYST
from intel.models import Cluster, Projection, Summary

logger = logging.getLogger(__name__)


@register_analyzer("projections")
class ProjectionsAnalyzer(BaseAnalyzer):
    """Generate calibrated near-term projections based on current intel."""

    @property
    def name(self) -> str:
        return "projections"

    async def analyze(
        self, clusters: list[Cluster], summaries: list[Summary]
    ) -> list[Any]:
        cfg = self.config.get("analyze", {}).get("projections", {})
        if not cfg.get("enabled", True):
            return []

        if not summaries:
            return []

        # Build digest text for the prompt
        summary_map = {s.cluster_id: s for s in summaries}
        digest_parts = []
        for cluster in clusters:
            summary = summary_map.get(cluster.id)
            if not summary:
                continue
            digest_parts.append(
                f"[{cluster.topic.upper()}] {cluster.label}\n"
                f"  What: {summary.what_happened}\n"
                f"  Why: {summary.why_it_matters}\n"
                f"  Next: {summary.whats_next}"
            )

        prompt = PROJECTIONS.format(digest="\n\n".join(digest_parts))

        provider = get_provider_for_task(self.config, "projections")
        response = await provider.complete(prompt, system=SYSTEM_ANALYST)

        try:
            data = json.loads(response.text)
            projs = data.get("projections", [])
        except (json.JSONDecodeError, KeyError):
            logger.warning("Failed to parse projections response")
            return []

        results = []
        for p in projs:
            proj = Projection(
                topic=p.get("topic", "general"),
                description=p["description"],
                timeframe=p.get("timeframe", "weeks"),
                confidence=p.get("confidence", "possible"),
                supporting_evidence=p.get("supporting_evidence", ""),
            )
            results.append(proj)

        logger.info("Generated %d projections", len(results))
        return results
