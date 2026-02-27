"""Per-cluster BLUF summarization using configured LLM."""

from __future__ import annotations

import json
import logging
import re

from intel.llm import get_provider_for_task
from intel.llm.prompts import SUMMARIZE_CLUSTER, SUMMARIZE_SINGLE, SYSTEM_ANALYST
from intel.models import Article, Cluster, Summary

logger = logging.getLogger(__name__)


def _normalize_quotes(text: str) -> str:
    """Replace smart/curly quotes with straight quotes for JSON parsing."""
    return (
        text
        .replace("\u201c", '"')   # left double quote
        .replace("\u201d", '"')   # right double quote
        .replace("\u2018", "'")   # left single quote
        .replace("\u2019", "'")   # right single quote
        .replace("\u2033", '"')   # double prime
        .replace("\u2032", "'")   # prime
    )


def _try_parse(text: str) -> dict | None:
    """Try json.loads with and without quote normalization."""
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    try:
        return json.loads(_normalize_quotes(text))
    except (json.JSONDecodeError, ValueError):
        pass
    return None


def _extract_json(text: str) -> dict | None:
    """Extract JSON from LLM output that may contain markdown fences or extra text."""
    # Try raw parse first
    result = _try_parse(text)
    if result is not None:
        return result

    # Strip markdown code fences
    fenced = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if fenced:
        result = _try_parse(fenced.group(1))
        if result is not None:
            return result

    # Find first { ... } block
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        result = _try_parse(brace.group(0))
        if result is not None:
            return result

    return None


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

    data = _extract_json(response.text)
    if data is None:
        logger.warning("Failed to parse summary for cluster %s, using raw text", cluster.label)
        # Use first article title as label if still default
        if cluster.label.startswith("Cluster ") and cluster.articles:
            cluster.label = cluster.articles[0].title
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

    data = _extract_json(response.text)
    if data is None:
        logger.warning("Failed to parse single summary, using raw text")
        data = {
            "what_happened": response.text[:500],
            "why_it_matters": "Parse error.",
            "whats_next": "Retry.",
            "confidence": "developing",
        }

    # Update cluster label from LLM or fall back to article title
    if data.get("label"):
        cluster.label = data["label"]
    elif cluster.label.startswith("Cluster "):
        cluster.label = article.title

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
    """Summarize all clusters concurrently, returning list of Summary objects."""
    import asyncio

    max_concurrent = config.get("pipeline", {}).get("max_concurrent_summaries", 10)
    sem = asyncio.Semaphore(max_concurrent)

    async def _safe_summarize(cluster: Cluster) -> Summary | None:
        async with sem:
            try:
                return await summarize_cluster(config, cluster)
            except Exception:
                logger.exception("Failed to summarize cluster: %s", cluster.label)
                return None

    results = await asyncio.gather(*[_safe_summarize(c) for c in clusters])
    return [s for s in results if s is not None]
