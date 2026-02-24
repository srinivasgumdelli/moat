"""Source fetcher registry."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intel.ingest.base import BaseSource

SOURCES: dict[str, type[BaseSource]] = {}


def register_source(name: str):
    """Decorator to register a source fetcher."""

    def decorator(cls):
        SOURCES[name] = cls
        return cls

    return decorator


# Import implementations to trigger registration
from intel.ingest.gdelt import GDELTSource  # noqa: E402, F401
from intel.ingest.rss import RSSSource  # noqa: E402, F401
from intel.ingest.serper import SerperSource  # noqa: E402, F401
