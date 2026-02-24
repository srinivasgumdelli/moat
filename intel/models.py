"""Core data models for the intel pipeline."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Article:
    """A single news article from any source."""

    url: str
    title: str
    content: str
    source_name: str
    source_type: str  # rss, gdelt, serper
    topic: str  # tech, geopolitics, finance
    published_at: datetime | None = None
    fetched_at: datetime = field(default_factory=datetime.utcnow)
    content_hash: str = ""
    embedding: list[float] = field(default_factory=list)
    cluster_id: int | None = None
    id: int | None = None

    def __post_init__(self):
        if not self.content_hash and self.content:
            self.content_hash = hashlib.sha256(self.content.encode()).hexdigest()[:16]


@dataclass
class Cluster:
    """A group of related articles."""

    topic: str
    label: str
    article_count: int
    run_id: int
    articles: list[Article] = field(default_factory=list)
    id: int | None = None


@dataclass
class Summary:
    """BLUF summary of a cluster."""

    cluster_id: int
    depth: str  # headline, briefing, deep_dive
    what_happened: str
    why_it_matters: str
    whats_next: str
    confidence: str  # confirmed, likely, developing, speculative
    sources: list[str] = field(default_factory=list)
    id: int | None = None


@dataclass
class CrossReference:
    """A connection between clusters."""

    cluster_ids: list[int]
    ref_type: str  # contradiction, pattern, implicit_connection
    description: str
    confidence: float
    id: int | None = None


@dataclass
class Projection:
    """A near-term projection based on current intel."""

    topic: str
    description: str
    timeframe: str  # days, weeks, months
    confidence: str  # likely, possible, speculative
    supporting_evidence: str
    outcome: str | None = None  # for accuracy tracking
    id: int | None = None


@dataclass
class PipelineRun:
    """Record of a single pipeline execution."""

    started_at: datetime = field(default_factory=datetime.utcnow)
    finished_at: datetime | None = None
    status: str = "running"  # running, completed, failed
    articles_fetched: int = 0
    articles_after_dedup: int = 0
    clusters_formed: int = 0
    llm_tokens_used: int = 0
    llm_cost_usd: float = 0.0
    id: int | None = None
