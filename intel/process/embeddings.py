"""Embedding generation using Model2Vec (lightweight, CPU-only)."""

from __future__ import annotations

import logging

import numpy as np

logger = logging.getLogger(__name__)

_model = None


def get_model(model_name: str = "minishlab/potion-base-8M"):
    """Lazy-load the embedding model."""
    global _model
    if _model is None:
        from model2vec import StaticModel

        logger.info("Loading embedding model: %s", model_name)
        _model = StaticModel.from_pretrained(model_name)
    return _model


def embed_texts(texts: list[str], model_name: str = "minishlab/potion-base-8M") -> np.ndarray:
    """Generate embeddings for a list of texts. Returns (N, D) array."""
    model = get_model(model_name)
    return model.encode(texts)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))
