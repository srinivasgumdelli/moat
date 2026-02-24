"""SQLite database schema, migrations, and query helpers."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from intel.models import Article, Cluster, CrossReference, PipelineRun, Projection, Summary

SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    topic TEXT NOT NULL,
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB,
    cluster_id INTEGER,
    run_id INTEGER
);

CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    label TEXT NOT NULL,
    article_count INTEGER NOT NULL DEFAULT 0,
    run_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id INTEGER NOT NULL,
    depth TEXT NOT NULL DEFAULT 'briefing',
    what_happened TEXT NOT NULL,
    why_it_matters TEXT NOT NULL,
    whats_next TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'developing',
    sources TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (cluster_id) REFERENCES clusters(id)
);

CREATE TABLE IF NOT EXISTS cross_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_ids TEXT NOT NULL DEFAULT '[]',
    ref_type TEXT NOT NULL,
    description TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5
);

CREATE TABLE IF NOT EXISTS projections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    description TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'possible',
    supporting_evidence TEXT NOT NULL,
    outcome TEXT,
    run_id INTEGER
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    articles_fetched INTEGER NOT NULL DEFAULT 0,
    articles_after_dedup INTEGER NOT NULL DEFAULT 0,
    clusters_formed INTEGER NOT NULL DEFAULT 0,
    llm_tokens_used INTEGER NOT NULL DEFAULT 0,
    llm_cost_usd REAL NOT NULL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_articles_topic ON articles(topic);
CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles(content_hash);
CREATE INDEX IF NOT EXISTS idx_articles_cluster_id ON articles(cluster_id);
CREATE INDEX IF NOT EXISTS idx_clusters_run_id ON clusters(run_id);
"""


def get_connection(db_path: str) -> sqlite3.Connection:
    """Get a SQLite connection with WAL mode enabled."""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: str) -> None:
    """Create all tables and set schema version."""
    conn = get_connection(db_path)
    try:
        conn.executescript(SCHEMA_SQL)
        conn.execute(
            "INSERT OR REPLACE INTO schema_version (version) VALUES (?)",
            (SCHEMA_VERSION,),
        )
        conn.commit()
    finally:
        conn.close()


def _dt_str(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _parse_dt(s: str | None) -> datetime | None:
    if s is None:
        return None
    return datetime.fromisoformat(s)


# --- Article helpers ---


def insert_article(conn: sqlite3.Connection, article: Article, run_id: int | None = None) -> int:
    """Insert an article, returning its ID. Skips duplicates by URL."""
    try:
        cur = conn.execute(
            """INSERT INTO articles
               (url, title, content, source_name, source_type, topic,
                published_at, fetched_at, content_hash, embedding, cluster_id, run_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                article.url,
                article.title,
                article.content,
                article.source_name,
                article.source_type,
                article.topic,
                _dt_str(article.published_at),
                _dt_str(article.fetched_at),
                article.content_hash,
                None,  # embedding stored separately
                article.cluster_id,
                run_id,
            ),
        )
        conn.commit()
        return cur.lastrowid
    except sqlite3.IntegrityError:
        # Duplicate URL — return existing
        row = conn.execute("SELECT id FROM articles WHERE url = ?", (article.url,)).fetchone()
        return row["id"] if row else -1


def get_articles_by_run(conn: sqlite3.Connection, run_id: int) -> list[Article]:
    """Fetch all articles for a given pipeline run."""
    rows = conn.execute("SELECT * FROM articles WHERE run_id = ?", (run_id,)).fetchall()
    return [_row_to_article(row) for row in rows]


def get_articles_by_topic(conn: sqlite3.Connection, topic: str, run_id: int) -> list[Article]:
    """Fetch articles by topic for a given run."""
    rows = conn.execute(
        "SELECT * FROM articles WHERE topic = ? AND run_id = ?", (topic, run_id)
    ).fetchall()
    return [_row_to_article(row) for row in rows]


def update_article_cluster(conn: sqlite3.Connection, article_id: int, cluster_id: int) -> None:
    """Set the cluster ID for an article."""
    conn.execute("UPDATE articles SET cluster_id = ? WHERE id = ?", (cluster_id, article_id))
    conn.commit()


def _row_to_article(row: sqlite3.Row) -> Article:
    return Article(
        id=row["id"],
        url=row["url"],
        title=row["title"],
        content=row["content"],
        source_name=row["source_name"],
        source_type=row["source_type"],
        topic=row["topic"],
        published_at=_parse_dt(row["published_at"]),
        fetched_at=_parse_dt(row["fetched_at"]),
        content_hash=row["content_hash"],
        cluster_id=row["cluster_id"],
    )


# --- Cluster helpers ---


def insert_cluster(conn: sqlite3.Connection, cluster: Cluster) -> int:
    """Insert a cluster, returning its ID."""
    cur = conn.execute(
        "INSERT INTO clusters (topic, label, article_count, run_id) VALUES (?, ?, ?, ?)",
        (cluster.topic, cluster.label, cluster.article_count, cluster.run_id),
    )
    conn.commit()
    return cur.lastrowid


def get_clusters_by_run(conn: sqlite3.Connection, run_id: int) -> list[Cluster]:
    """Fetch all clusters for a pipeline run."""
    rows = conn.execute("SELECT * FROM clusters WHERE run_id = ?", (run_id,)).fetchall()
    return [
        Cluster(
            id=row["id"],
            topic=row["topic"],
            label=row["label"],
            article_count=row["article_count"],
            run_id=row["run_id"],
        )
        for row in rows
    ]


# --- Summary helpers ---


def insert_summary(conn: sqlite3.Connection, summary: Summary) -> int:
    """Insert a summary, returning its ID."""
    cur = conn.execute(
        """INSERT INTO summaries
           (cluster_id, depth, what_happened, why_it_matters, whats_next, confidence, sources)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            summary.cluster_id,
            summary.depth,
            summary.what_happened,
            summary.why_it_matters,
            summary.whats_next,
            summary.confidence,
            json.dumps(summary.sources),
        ),
    )
    conn.commit()
    return cur.lastrowid


def get_summaries_by_run(conn: sqlite3.Connection, run_id: int) -> list[Summary]:
    """Fetch all summaries for a pipeline run (via clusters)."""
    rows = conn.execute(
        """SELECT s.* FROM summaries s
           JOIN clusters c ON s.cluster_id = c.id
           WHERE c.run_id = ?""",
        (run_id,),
    ).fetchall()
    return [
        Summary(
            id=row["id"],
            cluster_id=row["cluster_id"],
            depth=row["depth"],
            what_happened=row["what_happened"],
            why_it_matters=row["why_it_matters"],
            whats_next=row["whats_next"],
            confidence=row["confidence"],
            sources=json.loads(row["sources"]),
        )
        for row in rows
    ]


# --- CrossReference helpers ---


def insert_cross_reference(conn: sqlite3.Connection, xref: CrossReference) -> int:
    sql = (
        "INSERT INTO cross_references"
        " (cluster_ids, ref_type, description, confidence)"
        " VALUES (?, ?, ?, ?)"
    )
    cur = conn.execute(
        sql,
        (json.dumps(xref.cluster_ids), xref.ref_type, xref.description, xref.confidence),
    )
    conn.commit()
    return cur.lastrowid


# --- Projection helpers ---


def insert_projection(conn: sqlite3.Connection, proj: Projection, run_id: int) -> int:
    cur = conn.execute(
        """INSERT INTO projections
           (topic, description, timeframe, confidence, supporting_evidence, outcome, run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            proj.topic,
            proj.description,
            proj.timeframe,
            proj.confidence,
            proj.supporting_evidence,
            proj.outcome,
            run_id,
        ),
    )
    conn.commit()
    return cur.lastrowid


# --- PipelineRun helpers ---


def insert_run(conn: sqlite3.Connection, run: PipelineRun) -> int:
    cur = conn.execute(
        "INSERT INTO pipeline_runs (started_at, status) VALUES (?, ?)",
        (_dt_str(run.started_at), run.status),
    )
    conn.commit()
    return cur.lastrowid


def finish_run(conn: sqlite3.Connection, run_id: int, run: PipelineRun) -> None:
    conn.execute(
        """UPDATE pipeline_runs SET
           finished_at = ?, status = ?, articles_fetched = ?,
           articles_after_dedup = ?, clusters_formed = ?,
           llm_tokens_used = ?, llm_cost_usd = ?
           WHERE id = ?""",
        (
            _dt_str(run.finished_at),
            run.status,
            run.articles_fetched,
            run.articles_after_dedup,
            run.clusters_formed,
            run.llm_tokens_used,
            run.llm_cost_usd,
            run_id,
        ),
    )
    conn.commit()


def get_recent_runs(conn: sqlite3.Connection, limit: int = 10) -> list[dict]:
    """Fetch recent pipeline runs for stats display."""
    rows = conn.execute(
        "SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return [dict(row) for row in rows]
