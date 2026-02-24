"""CLI entrypoint: python -m intel {run|ingest|init-db|test-telegram|stats}."""

from __future__ import annotations

import asyncio
import logging
import sys

from intel.config import get_active_sources, get_active_topics, get_db_path, load_config
from intel.db import get_connection, get_recent_runs, init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("intel")


def cmd_init_db(config: dict) -> None:
    """Initialize the SQLite database."""
    db_path = get_db_path(config)
    init_db(db_path)
    print(f"Database initialized at {db_path}")


async def cmd_run(config: dict) -> None:
    """Run the full pipeline."""
    from intel.pipeline import run_pipeline

    db_path = get_db_path(config)
    init_db(db_path)  # Ensure tables exist
    await run_pipeline(config)


async def cmd_ingest(config: dict) -> None:
    """Fetch articles without summarizing (for testing sources)."""
    from intel.ingest import SOURCES

    active = get_active_sources(config)
    topics = get_active_topics(config)
    total = 0

    for source_name in active:
        if source_name not in SOURCES:
            print(f"Warning: source '{source_name}' not registered")
            continue
        source = SOURCES[source_name](config)
        for topic in topics:
            articles = await source.fetch(topic)
            print(f"  {source_name}/{topic}: {len(articles)} articles")
            total += len(articles)

    print(f"\nTotal: {total} articles fetched")


async def cmd_test_telegram(config: dict) -> None:
    """Send a test message via Telegram."""
    from intel.deliver import CHANNELS

    if "telegram" not in CHANNELS:
        print("Error: Telegram channel not registered")
        sys.exit(1)

    channel = CHANNELS["telegram"](config)
    success = await channel.send_test()
    if success:
        print("Telegram test message sent successfully")
    else:
        print("Telegram test failed — check logs")
        sys.exit(1)


def cmd_stats(config: dict) -> None:
    """Show recent pipeline run stats."""
    db_path = get_db_path(config)
    conn = get_connection(db_path)
    runs = get_recent_runs(conn, limit=10)
    conn.close()

    if not runs:
        print("No pipeline runs yet.")
        return

    print(f"{'Run':>4} {'Status':<10} {'Articles':<10} {'Clusters':<10} {'Cost':>8} {'Started'}")
    print("-" * 70)
    for r in runs:
        print(
            f"{r['id']:>4} {r['status']:<10} {r['articles_fetched']:<10} "
            f"{r['clusters_formed']:<10} ${r['llm_cost_usd']:>7.3f} {r['started_at']}"
        )


COMMANDS = {
    "run": cmd_run,
    "ingest": cmd_ingest,
    "init-db": cmd_init_db,
    "test-telegram": cmd_test_telegram,
    "stats": cmd_stats,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        available = ", ".join(COMMANDS)
        print(f"Usage: python -m intel {{{available}}}")
        sys.exit(1)

    command = sys.argv[1]
    config = load_config()
    handler = COMMANDS[command]

    if asyncio.iscoroutinefunction(handler):
        asyncio.run(handler(config))
    else:
        handler(config)


if __name__ == "__main__":
    main()
