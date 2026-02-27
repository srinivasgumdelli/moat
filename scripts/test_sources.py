#!/usr/bin/env python3
"""Live test of Reddit and X.com source fetchers.

Run from a machine with internet access (not sandboxed):

    python scripts/test_sources.py
    python scripts/test_sources.py --topic crypto
    python scripts/test_sources.py --source reddit
    python scripts/test_sources.py --source xcom --topic tech
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from intel.config import load_config
from intel.ingest.reddit import RedditSource
from intel.ingest.xcom import XSource


def _print_articles(source_name: str, articles: list) -> None:
    print(f"\n{'=' * 60}")
    print(f"  {source_name}: {len(articles)} articles")
    print(f"{'=' * 60}")
    for i, a in enumerate(articles, 1):
        print(f"\n  {i}. {a.title[:80]}")
        print(f"     URL:     {a.url[:80]}")
        print(f"     Source:  {a.source_name}")
        print(f"     Date:    {a.published_at or 'N/A'}")
        content_preview = (a.content or "")[:120].replace("\n", " ")
        print(f"     Content: {content_preview}...")


async def test_reddit(config: dict, topic: str) -> None:
    print(f"\n[Reddit] Fetching r/ feeds for '{topic}'...")
    source = RedditSource(config)
    articles = await source.fetch(topic)
    _print_articles(f"Reddit ({topic})", articles)


async def test_xcom(config: dict, topic: str) -> None:
    print(f"\n[X.com] Fetching xcancel feeds for '{topic}'...")
    source = XSource(config)
    articles = await source.fetch(topic)
    _print_articles(f"X.com ({topic})", articles)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Test Reddit and X.com sources")
    parser.add_argument(
        "--topic", default="tech",
        help="Topic to fetch (default: tech)",
    )
    parser.add_argument(
        "--source", choices=["reddit", "xcom", "both"], default="both",
        help="Which source to test (default: both)",
    )
    parser.add_argument(
        "--config", default=None,
        help="Config file path (default: config.yaml or CONFIG_PATH env)",
    )
    args = parser.parse_args()

    config_path = args.config or os.environ.get("CONFIG_PATH", "config.yaml")
    config = load_config(config_path)

    if args.source in ("reddit", "both"):
        await test_reddit(config, args.topic)

    if args.source in ("xcom", "both"):
        await test_xcom(config, args.topic)

    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
