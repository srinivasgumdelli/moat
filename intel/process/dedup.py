"""Deduplication processor using content hash and cosine similarity."""

from __future__ import annotations

import logging

from intel.models import Article
from intel.process import register_processor
from intel.process.base import BaseProcessor
from intel.process.embeddings import cosine_similarity, embed_texts

logger = logging.getLogger(__name__)


@register_processor("dedup")
class DedupProcessor(BaseProcessor):
    """Remove duplicate articles by content hash and embedding similarity."""

    @property
    def name(self) -> str:
        return "dedup"

    async def process(self, articles: list[Article]) -> list[Article]:
        cfg = self.config.get("process", {}).get("dedup", {})
        if not cfg.get("enabled", True):
            return articles

        # Phase 1: exact hash dedup
        seen_hashes: set[str] = set()
        hash_deduped = []
        for article in articles:
            if article.content_hash in seen_hashes:
                continue
            seen_hashes.add(article.content_hash)
            hash_deduped.append(article)

        removed_hash = len(articles) - len(hash_deduped)
        if removed_hash:
            logger.info("Hash dedup removed %d exact duplicates", removed_hash)

        # Phase 2: cosine similarity dedup
        threshold = cfg.get("cosine_threshold", 0.85)
        if len(hash_deduped) < 2:
            return hash_deduped

        model_name = self.config.get("process", {}).get("embeddings", {}).get(
            "model", "minishlab/potion-base-8M"
        )

        texts = [f"{a.title} {a.content[:500]}" for a in hash_deduped]
        embeddings = embed_texts(texts, model_name)

        # Store embeddings on articles
        for i, article in enumerate(hash_deduped):
            article.embedding = embeddings[i].tolist()

        keep = [True] * len(hash_deduped)
        for i in range(len(hash_deduped)):
            if not keep[i]:
                continue
            for j in range(i + 1, len(hash_deduped)):
                if not keep[j]:
                    continue
                sim = cosine_similarity(embeddings[i], embeddings[j])
                if sim >= threshold:
                    keep[j] = False

        result = [a for a, k in zip(hash_deduped, keep) if k]
        removed_sim = len(hash_deduped) - len(result)
        if removed_sim:
            logger.info(
                "Similarity dedup removed %d near-duplicates (threshold=%.2f)",
                removed_sim, threshold,
            )

        return result
