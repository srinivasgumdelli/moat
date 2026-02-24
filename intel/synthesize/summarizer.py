"""Per-cluster BLUF summarization using configured LLM."""

from __future__ import annotations

import json
import logging

from intel.llm import get_provider_for_task
from intel.llm.prompts import SUMMARIZE_CLUSTER, SUMMARIZE_SINGLE, SYSTEM_ANALYST
from intel.models import Article, Cluster, Summary

logger = logging.getLogger(__name__)


async def summarize_cluster(config: dict, cluster: Cluster) -> Summary:
    """Generate a BLUF summary for a cluster of articles."""
    provider = get_provider_for_task(config, "summarize")

    if len(cluster.articles) == 1:
        return await _summarize_single(config, cluster, cluster.articles[0])

    # Format articles for the prompt
    article_texts = []
    for i, article in enumerate(cluster.articles[:10], 1):  # Cap at 10
        text = (
            f"[{i}] {article.title} (Source: {article.source_name})\n"
            f"{article.content[:800]}"
        )
        article_texts.append(text)

    prompt = SUMMARIZE_CLUSTER.format(
        topic=cluster.topic,
        articles="\n\n".join(article_texts),
    )

    response = await provider.complete(prompt, system=SYSTEM_ANALYST)

    try:
        data = json.loads(response.text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse summary for cluster %s, using raw text", cluster.label)
        return Summary(
            cluster_id=cluster.id or 0,
            depth="briefing",
            what_happened=response.text[:500],
            why_it_matters="Parse error — raw LLM output used.",
            whats_next="Retry with different prompt.",
            confidence="developing",
            sources=[a.source_name for a in cluster.articles],
        )

    # Update cluster label from LLM
    if data.get("label"):
        cluster.label = data["label"]

    return Summary(
        cluster_id=cluster.id or 0,
        depth="briefing",
        what_happened=data.get("what_happened", ""),
        why_it_matters=data.get("why_it_matters", ""),
        whats_next=data.get("whats_next", ""),
        confidence=data.get("confidence", "developing"),
        sources=data.get("sources", [a.source_name for a in cluster.articles]),
    )


async def _summarize_single(config: dict, cluster: Cluster, article: Article) -> Summary:
    """Summarize a single article."""
    provider = get_provider_for_task(config, "summarize")

    prompt = SUMMARIZE_SINGLE.format(
        topic=cluster.topic,
        title=article.title,
        source=article.source_name,
        content=article.content[:2000],
    )

    response = await provider.complete(prompt, system=SYSTEM_ANALYST)

    try:
        data = json.loads(response.text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse single summary, using raw text")
        data = {
            "what_happened": response.text[:500],
            "why_it_matters": "Parse error.",
            "whats_next": "Retry.",
            "confidence": "developing",
        }

    return Summary(
        cluster_id=cluster.id or 0,
        depth="briefing",
        what_happened=data.get("what_happened", ""),
        why_it_matters=data.get("why_it_matters", ""),
        whats_next=data.get("whats_next", ""),
        confidence=data.get("confidence", "developing"),
        sources=[article.source_name],
    )


async def summarize_all_clusters(config: dict, clusters: list[Cluster]) -> list[Summary]:
    """Summarize all clusters, returning list of Summary objects."""
    summaries = []
    for cluster in clusters:
        try:
            summary = await summarize_cluster(config, cluster)
            summaries.append(summary)
        except Exception:
            logger.exception("Failed to summarize cluster: %s", cluster.label)
    return summaries
