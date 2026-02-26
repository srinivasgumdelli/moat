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
from intel.llm.batch import estimate_cost
from intel.models import PipelineRun
from intel.process.cluster import ClusterProcessor
from intel.process.dedup import DedupProcessor
from intel.synthesize.pdf import format_pdf_caption, render_pdf_digest
from intel.synthesize.report import format_digest, format_fallback_digest
from intel.synthesize.summarizer import summarize_all_clusters

logger = logging.getLogger(__name__)


class CostTracker:
    """Accumulate LLM token usage and cost across a pipeline run."""

    def __init__(self):
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cost_usd = 0.0

    def track(self, input_tokens: int, output_tokens: int, model: str):
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_cost_usd += estimate_cost(
            input_tokens, output_tokens, model,
        )


# Module-level tracker so summarizer/analyzers can report to it
_cost_tracker: CostTracker | None = None


def get_cost_tracker() -> CostTracker | None:
    return _cost_tracker


async def run_pipeline(config: dict) -> None:
    """Execute the full intel pipeline."""
    global _cost_tracker
    _cost_tracker = CostTracker()

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
                logger.warning(
                    "Source '%s' enabled but not registered", source_name,
                )
                continue
            source = SOURCES[source_name](config)
            for topic in topics:
                try:
                    articles = await source.fetch(topic)
                    all_articles.extend(articles)
                except Exception:
                    logger.exception(
                        "Source '%s' failed for topic '%s'",
                        source_name, topic,
                    )

        run.articles_fetched = len(all_articles)
        logger.info(
            "Ingested %d articles from %d sources",
            len(all_articles), len(active_sources),
        )

        if not all_articles:
            logger.warning("No articles fetched — aborting pipeline")
            run.status = "completed"
            run.finished_at = datetime.utcnow()
            finish_run(conn, run_id, run)
            return

        # --- Filter by age and cap per topic ---
        all_articles = _filter_articles(config, all_articles)

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
            clusters = cluster_proc.build_clusters(
                topic_articles, topic, run_id,
            )
            all_clusters.extend(clusters)

        # Store clusters and update article-cluster links
        for cluster in all_clusters:
            cluster.id = insert_cluster(conn, cluster)
            for article in cluster.articles:
                if article.id:
                    update_article_cluster(conn, article.id, cluster.id)

        run.clusters_formed = len(all_clusters)
        logger.info("Formed %d clusters", len(all_clusters))

        # --- Summarize (with fallback) ---
        summaries = await summarize_all_clusters(config, all_clusters)

        if summaries:
            for summary in summaries:
                for cluster in all_clusters:
                    if summary.cluster_id == 0 and cluster.articles:
                        summary.cluster_id = cluster.id
                        break
                insert_summary(conn, summary)
            logger.info("Generated %d summaries", len(summaries))
        else:
            logger.warning(
                "All summarization failed — using fallback digest",
            )

        # --- Analyze ---
        cross_refs = []
        projections = []
        trends = []

        if summaries:
            for analyzer_name, analyzer_cls in ANALYZERS.items():
                analyzer = analyzer_cls(config)
                try:
                    results = await analyzer.analyze(
                        all_clusters, summaries,
                    )
                    if analyzer_name == "crossref":
                        cross_refs = results
                        for xref in cross_refs:
                            insert_cross_reference(conn, xref)
                    elif analyzer_name == "projections":
                        projections = results
                        for proj in projections:
                            insert_projection(conn, proj, run_id)
                    elif analyzer_name == "trends":
                        trends = results
                except Exception:
                    logger.exception(
                        "Analyzer '%s' failed", analyzer_name,
                    )

        # --- Format report ---
        if summaries:
            digest = format_digest(
                all_clusters, summaries, cross_refs,
                projections, run, trends,
            )
        else:
            digest = format_fallback_digest(articles, run)
        logger.info("Digest formatted (%d chars)", len(digest))

        # --- Generate PDF if enabled ---
        pdf_bytes = None
        pdf_caption = None
        telegram_cfg = config.get("deliver", {}).get("telegram", {})
        if telegram_cfg.get("pdf_digest", False) and summaries:
            try:
                pdf_bytes = render_pdf_digest(
                    all_clusters, summaries, cross_refs,
                    projections, run, trends,
                )
                pdf_caption = format_pdf_caption(all_clusters, run)
                logger.info("PDF digest generated (%d bytes)", len(pdf_bytes))
            except Exception:
                logger.exception("PDF generation failed — falling back to text")
                pdf_bytes = None

        # --- Deliver ---
        for channel_name, channel_cls in CHANNELS.items():
            channel_cfg = config.get("deliver", {}).get(channel_name, {})
            if not channel_cfg.get("enabled", False):
                continue
            channel = channel_cls(config)
            try:
                if pdf_bytes and channel_name == "telegram":
                    date_str = datetime.utcnow().strftime("%Y-%m-%d")
                    success = await channel.send(
                        pdf_caption,
                        attachment=pdf_bytes,
                        attachment_name=f"intel-digest-{date_str}.pdf",
                    )
                else:
                    success = await channel.send(digest)
                if success:
                    logger.info("Delivered via %s", channel_name)
                else:
                    logger.error("Delivery failed via %s", channel_name)
            except Exception:
                logger.exception("Delivery error via %s", channel_name)

        # --- Finalize ---
        run.llm_tokens_used = (
            _cost_tracker.total_input_tokens
            + _cost_tracker.total_output_tokens
        )
        run.llm_cost_usd = _cost_tracker.total_cost_usd
        run.status = "completed"
        run.finished_at = datetime.utcnow()
        finish_run(conn, run_id, run)
        logger.info(
            "Pipeline run #%d completed: %d articles, %d clusters, "
            "%d tokens, $%.4f",
            run_id, run.articles_fetched, run.clusters_formed,
            run.llm_tokens_used, run.llm_cost_usd,
        )

    except Exception:
        logger.exception("Pipeline run #%d failed", run_id)
        run.status = "failed"
        run.finished_at = datetime.utcnow()
        if _cost_tracker:
            run.llm_tokens_used = (
                _cost_tracker.total_input_tokens
                + _cost_tracker.total_output_tokens
            )
            run.llm_cost_usd = _cost_tracker.total_cost_usd
        finish_run(conn, run_id, run)
        raise
    finally:
        conn.close()
        _cost_tracker = None


def _filter_articles(config: dict, articles: list) -> list:
    """Filter by age and cap per-topic count."""
    pipeline_cfg = config.get("pipeline", {})
    max_age_hours = pipeline_cfg.get("max_article_age_hours", 24)
    max_per_topic = pipeline_cfg.get("max_articles_per_topic", 30)

    now = datetime.utcnow()
    filtered = []
    for article in articles:
        if article.published_at:
            age_hours = (now - article.published_at).total_seconds() / 3600
            if age_hours > max_age_hours:
                continue
        filtered.append(article)

    # Cap per topic
    topic_counts: dict[str, int] = {}
    capped = []
    for article in filtered:
        count = topic_counts.get(article.topic, 0)
        if count < max_per_topic:
            capped.append(article)
            topic_counts[article.topic] = count + 1

    if len(capped) < len(articles):
        logger.info(
            "Filtered %d → %d articles (age/topic limits)",
            len(articles), len(capped),
        )

    return capped
