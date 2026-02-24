"""Tests for database operations."""

from __future__ import annotations

from datetime import datetime

from intel.db import (
    finish_run,
    get_articles_by_topic,
    get_clusters_by_run,
    get_recent_runs,
    get_summaries_by_run,
    insert_article,
    insert_cluster,
    insert_run,
    insert_summary,
    update_article_cluster,
)
from intel.models import Cluster, PipelineRun, Summary


def test_insert_and_fetch_article(db_conn, sample_articles):
    """Articles can be inserted and retrieved."""
    article = sample_articles[0]
    article_id = insert_article(db_conn, article, run_id=1)
    assert article_id > 0

    articles = get_articles_by_topic(db_conn, "tech", run_id=1)
    assert len(articles) == 1
    assert articles[0].title == article.title


def test_duplicate_url_skipped(db_conn, sample_articles):
    """Duplicate URLs are silently skipped."""
    article = sample_articles[0]
    id1 = insert_article(db_conn, article, run_id=1)
    id2 = insert_article(db_conn, article, run_id=1)
    assert id1 == id2


def test_insert_cluster(db_conn):
    """Clusters can be inserted and retrieved."""
    cluster = Cluster(topic="tech", label="Test Cluster", article_count=3, run_id=1)
    cluster_id = insert_cluster(db_conn, cluster)
    assert cluster_id > 0

    clusters = get_clusters_by_run(db_conn, run_id=1)
    assert len(clusters) == 1
    assert clusters[0].label == "Test Cluster"


def test_update_article_cluster(db_conn, sample_articles):
    """Article cluster assignment can be updated."""
    article_id = insert_article(db_conn, sample_articles[0], run_id=1)
    cluster = Cluster(topic="tech", label="Test", article_count=1, run_id=1)
    cluster_id = insert_cluster(db_conn, cluster)

    update_article_cluster(db_conn, article_id, cluster_id)

    articles = get_articles_by_topic(db_conn, "tech", run_id=1)
    assert articles[0].cluster_id == cluster_id


def test_insert_summary(db_conn):
    """Summaries can be inserted and retrieved."""
    cluster = Cluster(topic="tech", label="Test", article_count=1, run_id=1)
    cluster_id = insert_cluster(db_conn, cluster)

    summary = Summary(
        cluster_id=cluster_id,
        depth="briefing",
        what_happened="Something happened",
        why_it_matters="It matters because",
        whats_next="Watch for this",
        confidence="confirmed",
        sources=["Source A"],
    )
    summary_id = insert_summary(db_conn, summary)
    assert summary_id > 0

    summaries = get_summaries_by_run(db_conn, run_id=1)
    assert len(summaries) == 1
    assert summaries[0].what_happened == "Something happened"


def test_pipeline_run_lifecycle(db_conn):
    """Pipeline runs can be created and finalized."""
    run = PipelineRun()
    run_id = insert_run(db_conn, run)
    assert run_id > 0

    run.status = "completed"
    run.finished_at = datetime.utcnow()
    run.articles_fetched = 42
    run.clusters_formed = 5
    finish_run(db_conn, run_id, run)

    runs = get_recent_runs(db_conn, limit=5)
    assert len(runs) == 1
    assert runs[0]["status"] == "completed"
    assert runs[0]["articles_fetched"] == 42
