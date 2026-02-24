"""Abstract base class for analyzers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from intel.models import Cluster, Summary


class BaseAnalyzer(ABC):
    """Base class for analysis steps."""

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    async def analyze(
        self, clusters: list[Cluster], summaries: list[Summary]
    ) -> list[Any]:
        """Run analysis and return results."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Analyzer name."""
        ...
