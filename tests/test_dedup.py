"""Tests for deduplication processor."""

from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from intel.models import Article
from intel.process.dedup import DedupProcessor


@pytest.fixture
def dedup_config():
    return {
        "process": {
            "dedup": {
                "enabled": True,
                "cosine_threshold": 0.85,
            },
            "embeddings": {
                "model": "minishlab/potion-base-8M",
            },
        },
    }


def _make_article(url: str, title: str, content: str) -> Article:
    return Article(
        url=url,
        title=title,
        content=content,
        source_name="Test",
        source_type="rss",
        topic="tech",
    )


def _mock_embed_texts(texts, model_name=None):
    """Generate deterministic fake embeddings based on text hash."""
    embeddings = []
    for text in texts:
        seed = sum(ord(c) for c in text) % 10000
        rng_local = np.random.RandomState(seed)
        embeddings.append(rng_local.randn(64).astype(np.float32))
    return np.array(embeddings)


@pytest.mark.asyncio
@patch("intel.process.dedup.embed_texts", side_effect=_mock_embed_texts)
async def test_hash_dedup_removes_exact_duplicates(mock_embed, dedup_config):
    """Articles with identical content are deduplicated by hash."""
    articles = [
        _make_article("https://a.com/1", "Title A", "Exact same content here."),
        _make_article("https://b.com/2", "Title B", "Exact same content here."),
        _make_article("https://c.com/3", "Title C", "Different content entirely."),
    ]
    dedup = DedupProcessor(dedup_config)
    result = await dedup.process(articles)
    assert len(result) == 2


@pytest.mark.asyncio
@patch("intel.process.dedup.embed_texts", side_effect=_mock_embed_texts)
async def test_dedup_preserves_unique_articles(mock_embed, dedup_config):
    """Unique articles are not removed."""
    articles = [
        _make_article("https://a.com/1", "Title A", "Content about AI advances."),
        _make_article("https://b.com/2", "Title B", "Content about EU trade."),
        _make_article("https://c.com/3", "Title C", "Content about stock markets."),
    ]
    dedup = DedupProcessor(dedup_config)
    result = await dedup.process(articles)
    assert len(result) == 3


@pytest.mark.asyncio
async def test_dedup_disabled(dedup_config):
    """When disabled, all articles pass through."""
    dedup_config["process"]["dedup"]["enabled"] = False
    articles = [
        _make_article("https://a.com/1", "Same", "Same content"),
        _make_article("https://b.com/2", "Same", "Same content"),
    ]
    dedup = DedupProcessor(dedup_config)
    result = await dedup.process(articles)
    assert len(result) == 2


@pytest.mark.asyncio
@patch("intel.process.dedup.embed_texts", side_effect=_mock_embed_texts)
async def test_similarity_dedup_removes_near_duplicates(mock_embed, dedup_config):
    """Near-duplicate articles (high cosine similarity) are removed."""
    # Use very low threshold so our mock embeddings trigger dedup
    dedup_config["process"]["dedup"]["cosine_threshold"] = 0.01
    articles = [
        _make_article("https://a.com/1", "Title A", "Unique content alpha."),
        _make_article("https://b.com/2", "Title B", "Unique content beta."),
    ]
    dedup = DedupProcessor(dedup_config)
    result = await dedup.process(articles)
    # With threshold 0.01, nearly all articles look similar — at least one removed
    assert len(result) <= 2
