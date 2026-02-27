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
from intel.ingest.bluesky import BlueskySource  # noqa: E402, F401
from intel.ingest.gdelt import GDELTSource  # noqa: E402, F401
from intel.ingest.hackernews import HackerNewsSource  # noqa: E402, F401
from intel.ingest.lemmy import LemmySource  # noqa: E402, F401
from intel.ingest.reddit import RedditSource  # noqa: E402, F401
from intel.ingest.rss import RSSSource  # noqa: E402, F401
from intel.ingest.serper import SerperSource  # noqa: E402, F401
from intel.ingest.xcom import XSource  # noqa: E402, F401
