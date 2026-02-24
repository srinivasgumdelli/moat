"""Tests for clustering processor."""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from intel.models import Article
from intel.process.cluster import ClusterProcessor


@pytest.fixture
def cluster_config():
    return {
        "process": {
            "cluster": {
                "enabled": True,
                "distance_threshold": 0.6,
                "min_cluster_size": 2,
            },
            "embeddings": {
                "model": "minishlab/potion-base-8M",
            },
        },
    }


def _make_articles(n, topic="tech"):
    return [
        Article(
            url=f"https://example.com/{i}",
            title=f"Article {i}",
            content=f"Content {i}",
            source_name="Test",
            source_type="rss",
            topic=topic,
        )
        for i in range(n)
    ]


def _mock_embed_texts(texts, model_name=None):
    """Produce embeddings that cluster in predictable ways."""
    embeddings = []
    for i, text in enumerate(texts):
        vec = np.zeros(64, dtype=np.float32)
        # First half get similar embeddings, second half different
        if i < len(texts) // 2:
            vec[0] = 1.0
            vec[1] = 0.1 * i
        else:
            vec[10] = 1.0
            vec[11] = 0.1 * i
        embeddings.append(vec)
    return np.array(embeddings)


@pytest.mark.asyncio
@patch(
    "intel.process.cluster.embed_texts",
    side_effect=_mock_embed_texts,
)
async def test_cluster_assigns_ids(mock_embed, cluster_config):
    """Clustering assigns cluster_id to all articles."""
    articles = _make_articles(6)
    proc = ClusterProcessor(cluster_config)
    result = await proc.process(articles)

    assert len(result) == 6
    assert all(a.cluster_id is not None for a in result)


@pytest.mark.asyncio
@patch(
    "intel.process.cluster.embed_texts",
    side_effect=_mock_embed_texts,
)
async def test_cluster_groups_similar(mock_embed, cluster_config):
    """Similar articles get the same cluster ID."""
    articles = _make_articles(4)
    proc = ClusterProcessor(cluster_config)
    result = await proc.process(articles)

    # First two should be in same cluster (similar embeddings)
    assert result[0].cluster_id == result[1].cluster_id


@pytest.mark.asyncio
async def test_cluster_disabled(cluster_config):
    """Disabled clustering passes articles through unchanged."""
    cluster_config["process"]["cluster"]["enabled"] = False
    articles = _make_articles(3)
    proc = ClusterProcessor(cluster_config)
    result = await proc.process(articles)

    assert len(result) == 3
    assert all(a.cluster_id is None for a in result)


@pytest.mark.asyncio
async def test_cluster_single_article(cluster_config):
    """Single article is returned unchanged (no clustering)."""
    articles = _make_articles(1)
    proc = ClusterProcessor(cluster_config)
    result = await proc.process(articles)
    assert len(result) == 1


def test_build_clusters():
    """build_clusters groups articles by cluster_id."""
    articles = _make_articles(4)
    articles[0].cluster_id = 1
    articles[1].cluster_id = 1
    articles[2].cluster_id = 2
    articles[3].cluster_id = 2

    config = {"process": {"cluster": {"enabled": True}}}
    proc = ClusterProcessor(config)
    clusters = proc.build_clusters(articles, "tech", run_id=1)

    assert len(clusters) == 2
    assert clusters[0].article_count == 2
    assert clusters[1].article_count == 2
    assert clusters[0].topic == "tech"
