"""Analyzer registry for cross-referencing, projections, etc."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intel.analyze.base import BaseAnalyzer

ANALYZERS: dict[str, type[BaseAnalyzer]] = {}


def register_analyzer(name: str):
    """Decorator to register an analyzer."""

    def decorator(cls):
        ANALYZERS[name] = cls
        return cls

    return decorator


from intel.analyze.crossref import CrossRefAnalyzer  # noqa: E402, F401
from intel.analyze.projections import ProjectionsAnalyzer  # noqa: E402, F401
from intel.analyze.trends import TrendsAnalyzer  # noqa: E402, F401
