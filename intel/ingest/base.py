"""Abstract base class for all source fetchers."""

from __future__ import annotations

from abc import ABC, abstractmethod

from intel.models import Article


class BaseSource(ABC):
    """Base class for news source fetchers."""

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    async def fetch(self, topic: str) -> list[Article]:
        """Fetch articles for a given topic. Returns list of Article objects."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable source name."""
        ...
