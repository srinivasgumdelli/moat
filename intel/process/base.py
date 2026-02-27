"""Abstract base class for processors."""

from __future__ import annotations

from abc import ABC, abstractmethod

from intel.models import Article


class BaseProcessor(ABC):
    """Base class for article processing steps."""

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    async def process(self, articles: list[Article]) -> list[Article]:
        """Process articles and return filtered/modified list."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Processor name."""
        ...
