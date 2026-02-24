"""Processor registry for dedup, clustering, etc."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intel.process.base import BaseProcessor

PROCESSORS: dict[str, type[BaseProcessor]] = {}


def register_processor(name: str):
    """Decorator to register a processor."""

    def decorator(cls):
        PROCESSORS[name] = cls
        return cls

    return decorator


from intel.process.cluster import ClusterProcessor  # noqa: E402, F401
from intel.process.dedup import DedupProcessor  # noqa: E402, F401
