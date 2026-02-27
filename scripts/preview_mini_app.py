#!/usr/bin/env python3
"""Generate HTML digest preview and optionally send a test Mini App button to Telegram.

Usage:
  # Just generate the HTML file and open in browser
  python scripts/preview_mini_app.py

  # Also send a Telegram message with Mini App button (needs ngrok URL)
  python scripts/preview_mini_app.py --send https://xxxx.ngrok-free.app/digest.html
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from intel.config import load_config
from intel.models import (
    Article,
    Cluster,
    CrossReference,
    PipelineRun,
    Projection,
    Summary,
    Trend,
)
from intel.synthesize.html import render_html_digest


def build_sample_data(config: dict):
    """Build realistic sample data for preview."""
    def _a(url, title, source, topic):
        return Article(
            url=url, title=title, content="", source_name=source,
            source_type="rss", topic=topic,
        )

    clusters = [
        Cluster(
            id=1, topic="tech",
            label="OpenAI Releases GPT-5 With Reasoning Capabilities",
            article_count=4, run_id=1,
            articles=[
                _a("https://arstechnica.com/ai/2026/02/openai-gpt5",
                    "OpenAI GPT-5", "Ars Technica", "tech"),
                _a("https://techcrunch.com/2026/02/27/gpt-5-launch",
                    "GPT-5 Launch", "TechCrunch AI", "tech"),
                _a("https://theverge.com/2026/2/27/openai-gpt-5",
                    "GPT-5 Reasoning", "The Verge AI", "tech"),
                _a("https://openai.com/blog/gpt-5",
                    "Introducing GPT-5", "OpenAI Blog", "tech"),
            ],
        ),
        Cluster(
            id=2, topic="tech",
            label="EU AI Act Enforcement Begins With First Fines",
            article_count=3, run_id=1,
            articles=[
                _a("https://bbc.co.uk/news/technology-eu-ai-act",
                    "EU AI Act Fines", "BBC World", "tech"),
                _a("https://ft.com/content/eu-ai-regulation",
                    "EU AI Regulation", "Financial Times", "tech"),
                _a("https://aljazeera.com/economy/eu-ai-fines",
                    "EU Issues AI Fines", "Al Jazeera", "tech"),
            ],
        ),
        Cluster(
            id=3, topic="geopolitics",
            label="US-China Trade Talks Resume After Six-Month Pause",
            article_count=3, run_id=1,
            articles=[
                _a("https://nytimes.com/2026/02/27/world/us-china-trade",
                    "US-China Trade Talks", "NYT World", "geopolitics"),
                _a("https://bloomberg.com/news/us-china-geneva",
                    "Geneva Trade Talks", "Bloomberg Markets", "geopolitics"),
                _a("https://bbc.co.uk/news/world-us-china-trade",
                    "Trade Talks Resume", "BBC World", "geopolitics"),
            ],
        ),
        Cluster(
            id=4, topic="geopolitics",
            label="NATO Members Increase Defense Spending Commitments",
            article_count=2, run_id=1,
            articles=[
                _a("https://bbc.co.uk/news/world-nato-spending",
                    "NATO Spending Increase", "BBC World", "geopolitics"),
                _a("https://nytimes.com/2026/02/27/world/nato-defense",
                    "NATO Defense Budgets", "NYT World", "geopolitics"),
            ],
        ),
        Cluster(
            id=5, topic="finance",
            label="Federal Reserve Signals Rate Cuts in Q2",
            article_count=3, run_id=1,
            articles=[
                _a("https://bloomberg.com/news/fed-rate-cut-signal",
                    "Fed Rate Signal", "Bloomberg Markets", "finance"),
                _a("https://ft.com/content/fed-dovish-pivot",
                    "Fed Dovish Pivot", "Financial Times", "finance"),
                _a("https://finance.yahoo.com/news/fed-rate-cuts",
                    "Fed Rate Cuts Expected", "Yahoo Finance", "finance"),
            ],
        ),
        Cluster(
            id=6, topic="finance",
            label="Bitcoin ETF Inflows Hit Record $2.1B Weekly",
            article_count=2, run_id=1,
            articles=[
                _a("https://bloomberg.com/news/bitcoin-etf-inflows",
                    "Bitcoin ETF Record", "Bloomberg Markets", "finance"),
                _a("https://finance.yahoo.com/news/bitcoin-etf-2b",
                    "Bitcoin ETF Inflows", "Yahoo Finance", "finance"),
            ],
        ),
    ]

    summaries = [
        Summary(
            cluster_id=1, depth="briefing",
            what_happened="OpenAI launched GPT-5 with native chain-of-thought reasoning, "
            "scoring 92% on graduate-level math benchmarks and demonstrating multi-step "
            "planning capabilities previously unseen in language models.",
            why_it_matters="Narrows the gap between AI and human-level reasoning. Enterprise "
            "adoption could accelerate as the model handles complex analytical tasks that "
            "previously required human experts.",
            whats_next="Expect competitor responses from Anthropic and Google within weeks. "
            "Watch for enterprise pricing announcements and API availability timeline.",
            confidence="confirmed",
            sources=["Ars Technica", "TechCrunch AI", "The Verge AI", "OpenAI Blog"],
        ),
        Summary(
            cluster_id=2, depth="briefing",
            what_happened="The European Commission issued its first fines under the AI Act, "
            "targeting two companies for deploying high-risk AI systems without required "
            "conformity assessments.",
            why_it_matters="Sets enforcement precedent for the world's most comprehensive AI "
            "regulation. Companies operating in the EU must now treat compliance as urgent "
            "rather than aspirational.",
            whats_next="More enforcement actions expected in coming months. US tech companies "
            "with EU operations are reviewing their AI governance frameworks.",
            confidence="confirmed",
            sources=["BBC World", "Financial Times", "Al Jazeera"],
        ),
        Summary(
            cluster_id=3, depth="briefing",
            what_happened="Senior US and Chinese trade officials met in Geneva for the first "
            "formal negotiations since August, discussing semiconductor export controls "
            "and agricultural tariffs.",
            why_it_matters="Could de-escalate the tech decoupling trend that has disrupted "
            "global supply chains. Markets responded positively to the reopening of dialogue.",
            whats_next="Follow-up ministerial meeting scheduled for March. Key sticking point "
            "remains advanced chip export restrictions.",
            confidence="likely",
            sources=["NYT World", "Bloomberg Markets", "BBC World"],
        ),
        Summary(
            cluster_id=4, depth="briefing",
            what_happened="Five additional NATO members committed to exceeding the 2% GDP "
            "defense spending target, bringing the total to 23 of 32 member states.",
            why_it_matters="Signals sustained shift in European defense posture. Increased "
            "spending benefits defense contractors but pressures domestic budgets.",
            whats_next="NATO summit in June will formalize new spending floor. Watch for "
            "procurement contract announcements from European defense firms.",
            confidence="confirmed",
            sources=["BBC World", "NYT World"],
        ),
        Summary(
            cluster_id=5, depth="briefing",
            what_happened="Fed Chair signaled openness to rate cuts beginning Q2 2026, citing "
            "cooling inflation data and softening labor market indicators. Markets priced "
            "in 75bps of cuts by year-end.",
            why_it_matters="First clear dovish pivot since the hiking cycle began. Lower rates "
            "would ease borrowing costs for consumers and businesses, potentially reigniting "
            "housing market activity.",
            whats_next="March FOMC meeting is the next decision point. Watch February jobs "
            "report and CPI data for confirmation of the dovish trajectory.",
            confidence="likely",
            sources=["Bloomberg Markets", "Financial Times", "Yahoo Finance"],
        ),
        Summary(
            cluster_id=6, depth="briefing",
            what_happened="Spot Bitcoin ETFs saw $2.1 billion in net inflows last week, the "
            "highest since launch. BlackRock's IBIT alone accounted for $800 million.",
            why_it_matters="Institutional adoption accelerating beyond early-adopter phase. "
            "ETF inflows are creating sustained buy pressure independent of retail sentiment.",
            whats_next="Ethereum ETF approval decision due next month. Watch for sovereign "
            "wealth fund disclosures in upcoming 13F filings.",
            confidence="confirmed",
            sources=["Bloomberg Markets", "Yahoo Finance"],
        ),
    ]

    cross_refs = [
        CrossReference(
            cluster_ids=[1, 2], ref_type="pattern",
            description="AI capability advances (GPT-5) and AI regulation enforcement (EU "
            "fines) are accelerating simultaneously — creating tension between innovation "
            "speed and compliance readiness.",
            confidence=0.85,
        ),
        CrossReference(
            cluster_ids=[3, 5], ref_type="implicit_connection",
            description="US-China trade thaw could influence Fed rate decisions — reduced "
            "trade tensions ease inflation pressure, supporting the dovish pivot.",
            confidence=0.7,
        ),
        CrossReference(
            cluster_ids=[4, 5], ref_type="contradiction",
            description="Increased NATO defense spending creates fiscal pressure that "
            "conflicts with rate-cut expectations — governments may need to borrow more, "
            "complicating the easing narrative.",
            confidence=0.6,
        ),
    ]

    projections = [
        Projection(
            topic="tech",
            description="Major cloud providers will announce GPT-5 integration within their "
            "platforms, triggering a new round of enterprise AI adoption.",
            timeframe="weeks",
            confidence="likely",
            supporting_evidence="Historical pattern: Azure integrated GPT-4 within 3 weeks of "
            "launch. AWS and GCP followed within a month.",
        ),
        Projection(
            topic="geopolitics",
            description="US-China semiconductor negotiations will produce a partial agreement "
            "on legacy chip exports while advanced chip restrictions remain.",
            timeframe="months",
            confidence="possible",
            supporting_evidence="Both sides have signaled willingness to compromise on "
            "non-cutting-edge technology.",
        ),
        Projection(
            topic="finance",
            description="First Fed rate cut in May 2026, with markets front-running the move "
            "by rotating into rate-sensitive sectors.",
            timeframe="months",
            confidence="likely",
            supporting_evidence="Fed funds futures pricing 85% probability of May cut. "
            "Housing and small-cap indices already showing relative strength.",
        ),
        Projection(
            topic="finance",
            description="Bitcoin reaches new all-time high above $110K driven by sustained "
            "ETF inflows and rate-cut expectations.",
            timeframe="weeks",
            confidence="speculative",
            supporting_evidence="Current ETF inflow pace and historical correlation with "
            "monetary easing cycles.",
        ),
    ]

    trends = [
        Trend(
            topic="tech",
            current_label="AI Reasoning Race",
            previous_label="AI Scaling Race",
            trend_type="escalating",
            description="Competition shifting from model size to reasoning capability.",
        ),
        Trend(
            topic="geopolitics",
            current_label="US-China Selective Engagement",
            previous_label="US-China Full Decoupling",
            trend_type="de-escalating",
            description="Both sides moving toward targeted restrictions "
            "rather than broad decoupling.",
        ),
    ]

    run = PipelineRun(
        articles_fetched=127,
        clusters_formed=6,
        llm_tokens_used=48500,
        llm_cost_usd=0.18,
    )

    return clusters, summaries, cross_refs, projections, trends, run


async def send_test_message(config: dict, web_app_url: str):
    """Send a test Telegram message with Mini App button."""
    from intel.deliver.telegram import TelegramDelivery

    channel = TelegramDelivery(config)
    success = await channel.send(
        "<b>INTEL DIGEST</b> — Preview\n6 clusters from 127 articles",
        web_app_url=web_app_url,
    )
    if success:
        print("Telegram message with Mini App button sent!")
    else:
        print("Failed to send Telegram message — check bot_token and chat_id")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Preview Mini App HTML digest")
    parser.add_argument(
        "--send", metavar="URL",
        help="Send Telegram message with Mini App button pointing to this HTTPS URL",
    )
    parser.add_argument(
        "--output", default="digest_preview.html",
        help="Output HTML file path (default: digest_preview.html)",
    )
    args = parser.parse_args()

    config = load_config(os.environ.get("CONFIG_PATH", "config.yaml"))
    clusters, summaries, cross_refs, projections, trends, run = build_sample_data(config)

    html = render_html_digest(
        clusters, summaries, cross_refs, projections, run, trends, config=config,
    )

    with open(args.output, "w") as f:
        f.write(html)
    print(f"HTML digest written to {args.output}")
    print(f"  Open in browser: file://{os.path.abspath(args.output)}")

    if args.send:
        print(f"\nSending Telegram message with Mini App URL: {args.send}")
        asyncio.run(send_test_message(config, args.send))


if __name__ == "__main__":
    main()
