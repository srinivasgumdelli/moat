"""CLI entrypoint: python -m intel {run|ingest|init-db|test-telegram|stats}."""

from __future__ import annotations

import asyncio
import logging
import logging.handlers
import os
import sys
from pathlib import Path

from intel.config import (
    get_active_sources,
    get_active_topics,
    get_db_path,
    load_config,
)
from intel.db import get_connection, get_recent_runs, init_db


def setup_logging(config: dict) -> None:
    """Configure logging with console + rotating file output."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    # File handler (rotate at 5MB, keep 3 backups)
    db_path = get_db_path(config)
    log_dir = Path(db_path).parent
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "intel.log"

    file_handler = logging.handlers.RotatingFileHandler(
        str(log_file), maxBytes=5 * 1024 * 1024, backupCount=3,
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    # Quiet noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("trafilatura").setLevel(logging.WARNING)
    logging.getLogger("feedparser").setLevel(logging.WARNING)


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
    init_db(db_path)
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

    header = (
        f"{'Run':>4} {'Status':<10} {'Articles':<10} "
        f"{'Clusters':<10} {'Cost':>8} {'Started'}"
    )
    print(header)
    print("-" * 70)
    for r in runs:
        print(
            f"{r['id']:>4} {r['status']:<10} "
            f"{r['articles_fetched']:<10} "
            f"{r['clusters_formed']:<10} "
            f"${r['llm_cost_usd']:>7.3f} {r['started_at']}"
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
    config = load_config(os.environ.get("CONFIG_PATH", "config.yaml"))
    setup_logging(config)
    handler = COMMANDS[command]

    if asyncio.iscoroutinefunction(handler):
        asyncio.run(handler(config))
    else:
        handler(config)


if __name__ == "__main__":
    main()
