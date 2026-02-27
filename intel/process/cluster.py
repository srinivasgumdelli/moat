"""Agglomerative clustering of articles by embedding similarity."""

from __future__ import annotations

import logging

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

from intel.models import Article, Cluster
from intel.process import register_processor
from intel.process.base import BaseProcessor
from intel.process.embeddings import embed_texts

logger = logging.getLogger(__name__)


@register_processor("cluster")
class ClusterProcessor(BaseProcessor):
    """Group articles into clusters using agglomerative clustering."""

    @property
    def name(self) -> str:
        return "cluster"

    async def process(self, articles: list[Article]) -> list[Article]:
        """Assign cluster IDs to articles. Returns articles with cluster_id set."""
        cfg = self.config.get("process", {}).get("cluster", {})
        if not cfg.get("enabled", True) or len(articles) < 2:
            return articles

        distance_threshold = cfg.get("distance_threshold", 0.6)

        # Get or compute embeddings
        model_name = self.config.get("process", {}).get("embeddings", {}).get(
            "model", "minishlab/potion-base-8M"
        )

        needs_embedding = [not a.embedding for a in articles]
        if any(needs_embedding):
            texts = [f"{a.title} {a.content[:500]}" for a in articles]
            embeddings = embed_texts(texts, model_name)
            for i, article in enumerate(articles):
                if not article.embedding:
                    article.embedding = embeddings[i].tolist()

        emb_matrix = np.array([a.embedding for a in articles])

        # Agglomerative clustering
        Z = linkage(emb_matrix, method="average", metric="cosine")
        labels = fcluster(Z, t=distance_threshold, criterion="distance")

        for i, article in enumerate(articles):
            article.cluster_id = int(labels[i])

        n_clusters = len(set(labels))
        logger.info(
            "Clustered %d articles into %d clusters (threshold=%.2f)",
            len(articles), n_clusters, distance_threshold,
        )

        return articles

    def build_clusters(
        self, articles: list[Article], topic: str, run_id: int
    ) -> list[Cluster]:
        """Build Cluster objects from articles with assigned cluster_ids."""
        cluster_map: dict[int, list[Article]] = {}
        for article in articles:
            if article.cluster_id is not None:
                cluster_map.setdefault(article.cluster_id, []).append(article)

        clusters = []
        for cluster_id, cluster_articles in cluster_map.items():
            cluster = Cluster(
                topic=topic,
                label=f"Cluster {cluster_id}",  # Will be relabeled by LLM
                article_count=len(cluster_articles),
                run_id=run_id,
                articles=cluster_articles,
            )
            clusters.append(cluster)

        return clusters
