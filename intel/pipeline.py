"""Pipeline orchestrator — wires together all registered components."""

from __future__ import annotations

import logging
from datetime import datetime

from intel.analyze import ANALYZERS
from intel.config import get_active_sources, get_active_topics, get_db_path
from intel.db import (
    finish_run,
    get_connection,
    insert_article,
    insert_cluster,
    insert_cross_reference,
    insert_projection,
    insert_run,
    insert_summary,
    update_article_cluster,
)
from intel.deliver import CHANNELS
from intel.ingest import SOURCES
from intel.models import PipelineRun
from intel.process.cluster import ClusterProcessor
from intel.process.dedup import DedupProcessor
from intel.synthesize.report import format_digest
from intel.synthesize.summarizer import summarize_all_clusters

logger = logging.getLogger(__name__)


async def run_pipeline(config: dict) -> None:
    """Execute the full intel pipeline."""
    db_path = get_db_path(config)
    conn = get_connection(db_path)
    run = PipelineRun()
    run_id = insert_run(conn, run)
    logger.info("Pipeline run #%d started", run_id)

    try:
        # --- Ingest ---
        active_sources = get_active_sources(config)
        topics = get_active_topics(config)
        all_articles = []

        for source_name in active_sources:
            if source_name not in SOURCES:
                logger.warning("Source '%s' enabled but not registered", source_name)
                continue
            source = SOURCES[source_name](config)
            for topic in topics:
                articles = await source.fetch(topic)
                all_articles.extend(articles)

        run.articles_fetched = len(all_articles)
        logger.info("Ingested %d articles from %d sources", len(all_articles), len(active_sources))

        if not all_articles:
            logger.warning("No articles fetched — aborting pipeline")
            run.status = "completed"
            run.finished_at = datetime.utcnow()
            finish_run(conn, run_id, run)
            return

        # --- Store raw articles ---
        for article in all_articles:
            article.id = insert_article(conn, article, run_id)

        # --- Dedup ---
        dedup = DedupProcessor(config)
        articles = await dedup.process(all_articles)
        run.articles_after_dedup = len(articles)
        logger.info("After dedup: %d articles", len(articles))

        # --- Cluster ---
        cluster_proc = ClusterProcessor(config)
        articles = await cluster_proc.process(articles)

        # Build cluster objects per topic
        all_clusters = []
        for topic in topics:
            topic_articles = [a for a in articles if a.topic == topic]
            if not topic_articles:
                continue
            clusters = cluster_proc.build_clusters(topic_articles, topic, run_id)
            all_clusters.extend(clusters)

        # Store clusters and update article-cluster links
        for cluster in all_clusters:
            cluster.id = insert_cluster(conn, cluster)
            for article in cluster.articles:
                if article.id:
                    update_article_cluster(conn, article.id, cluster.id)

        run.clusters_formed = len(all_clusters)
        logger.info("Formed %d clusters", len(all_clusters))

        # --- Summarize ---
        summaries = await summarize_all_clusters(config, all_clusters)
        for summary in summaries:
            # Update cluster_id to match stored cluster
            for cluster in all_clusters:
                if summary.cluster_id == 0 and cluster.articles:
                    summary.cluster_id = cluster.id
                    break
            insert_summary(conn, summary)

        logger.info("Generated %d summaries", len(summaries))

        # --- Analyze ---
        cross_refs = []
        projections = []

        for analyzer_name, analyzer_cls in ANALYZERS.items():
            analyzer = analyzer_cls(config)
            try:
                results = await analyzer.analyze(all_clusters, summaries)
                if analyzer_name == "crossref":
                    cross_refs = results
                    for xref in cross_refs:
                        insert_cross_reference(conn, xref)
                elif analyzer_name == "projections":
                    projections = results
                    for proj in projections:
                        insert_projection(conn, proj, run_id)
            except Exception:
                logger.exception("Analyzer '%s' failed", analyzer_name)

        # --- Format report ---
        digest = format_digest(all_clusters, summaries, cross_refs, projections, run)
        logger.info("Digest formatted (%d chars)", len(digest))

        # --- Deliver ---
        for channel_name, channel_cls in CHANNELS.items():
            channel_cfg = config.get("deliver", {}).get(channel_name, {})
            if not channel_cfg.get("enabled", False):
                continue
            channel = channel_cls(config)
            try:
                success = await channel.send(digest)
                if success:
                    logger.info("Delivered via %s", channel_name)
                else:
                    logger.error("Delivery failed via %s", channel_name)
            except Exception:
                logger.exception("Delivery error via %s", channel_name)

        # --- Finalize ---
        run.status = "completed"
        run.finished_at = datetime.utcnow()
        finish_run(conn, run_id, run)
        logger.info("Pipeline run #%d completed", run_id)

    except Exception:
        logger.exception("Pipeline run #%d failed", run_id)
        run.status = "failed"
        run.finished_at = datetime.utcnow()
        finish_run(conn, run_id, run)
        raise
    finally:
        conn.close()
