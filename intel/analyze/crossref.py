"""Cross-reference analyzer — finds connections between clusters across topics."""

from __future__ import annotations

import json
import logging
from typing import Any

from intel.analyze import register_analyzer
from intel.analyze.base import BaseAnalyzer
from intel.llm import get_provider_for_task
from intel.llm.prompts import CROSSREF, SYSTEM_ANALYST
from intel.models import Cluster, CrossReference, Summary

logger = logging.getLogger(__name__)


@register_analyzer("crossref")
class CrossRefAnalyzer(BaseAnalyzer):
    """Detect contradictions, patterns, and implicit connections across clusters."""

    @property
    def name(self) -> str:
        return "crossref"

    async def analyze(
        self, clusters: list[Cluster], summaries: list[Summary]
    ) -> list[Any]:
        cfg = self.config.get("analyze", {}).get("crossref", {})
        if not cfg.get("enabled", True):
            return []

        if len(clusters) < 2:
            return []

        # Build cluster descriptions for the prompt
        summary_map = {s.cluster_id: s for s in summaries}
        cluster_descs = []
        for i, cluster in enumerate(clusters):
            summary = summary_map.get(cluster.id)
            if summary:
                desc = (
                    f"[Cluster {cluster.id}] Topic: {cluster.topic} | "
                    f"Label: {cluster.label}\n"
                    f"  What: {summary.what_happened}\n"
                    f"  Why: {summary.why_it_matters}"
                )
            else:
                desc = (
                    f"[Cluster {cluster.id}] Topic: {cluster.topic} | "
                    f"Label: {cluster.label} ({cluster.article_count} articles)"
                )
            cluster_descs.append(desc)

        prompt = CROSSREF.format(clusters="\n\n".join(cluster_descs))

        provider = get_provider_for_task(self.config, "crossref")
        response = await provider.complete(prompt, system=SYSTEM_ANALYST)

        try:
            data = json.loads(response.text)
            refs = data.get("cross_references", [])
        except (json.JSONDecodeError, KeyError):
            logger.warning("Failed to parse crossref response")
            return []

        results = []
        for ref in refs:
            xref = CrossReference(
                cluster_ids=ref["cluster_ids"],
                ref_type=ref["ref_type"],
                description=ref["description"],
                confidence=ref.get("confidence", 0.5),
            )
            results.append(xref)

        logger.info("Found %d cross-references", len(results))
        return results
