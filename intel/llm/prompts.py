"""Prompt templates for all LLM tasks."""

SYSTEM_ANALYST = """You are a senior intelligence analyst producing briefings for a decision-maker.
Be concise, factual, and highlight what matters. Use active voice.
Never fabricate information — if uncertain, say so."""

SUMMARIZE_CLUSTER = """\
Analyze the following cluster of related news articles and produce a \
BLUF (Bottom Line Up Front) summary.

TOPIC: {topic}
ARTICLES:
{articles}

Respond in EXACTLY this JSON format (no markdown, no extra text):
{{
    "label": "Short descriptive label for this story (5-8 words)",
    "confidence": "confirmed|likely|developing|speculative",
    "what_happened": "1-2 sentences on what happened",
    "why_it_matters": "1-2 sentences on significance and implications",
    "whats_next": "1 sentence on what to watch for next",
    "sources": ["source1", "source2"]
}}"""

SUMMARIZE_SINGLE = """Analyze this news article and produce a BLUF summary.

TOPIC: {topic}
TITLE: {title}
SOURCE: {source}
CONTENT:
{content}

Respond in EXACTLY this JSON format (no markdown, no extra text):
{{
    "confidence": "confirmed|likely|developing|speculative",
    "what_happened": "1-2 sentences on what happened",
    "why_it_matters": "1-2 sentences on significance and implications",
    "whats_next": "1 sentence on what to watch for next"
}}"""

LABEL_CLUSTER = """\
Given these article titles from a news cluster, provide a short \
descriptive label (5-8 words).

TITLES:
{titles}

Respond with ONLY the label, nothing else."""

CROSSREF = """\
You are analyzing news clusters across different topics to find \
cross-domain connections.

CLUSTERS:
{clusters}

Identify connections between clusters from DIFFERENT topics. Look for:
1. CONTRADICTIONS — conflicting narratives or data
2. PATTERNS — similar dynamics playing out across domains
3. IMPLICIT CONNECTIONS — one event likely to affect another domain

Respond in JSON format (no markdown):
{{
    "cross_references": [
        {{
            "cluster_ids": [1, 3],
            "ref_type": "pattern|contradiction|implicit_connection",
            "description": "Brief description of the connection",
            "confidence": 0.0-1.0
        }}
    ]
}}

If no meaningful connections exist, return {{"cross_references": []}}."""

PROJECTIONS = """Based on the following intelligence digest, generate 2-4 near-term projections.

DIGEST:
{digest}

For each projection, assess:
- Timeframe: days, weeks, or months
- Confidence: likely (>70%), possible (40-70%), speculative (<40%)

Respond in JSON format (no markdown):
{{
    "projections": [
        {{
            "topic": "tech|geopolitics|finance",
            "description": "What you expect to happen",
            "timeframe": "days|weeks|months",
            "confidence": "likely|possible|speculative",
            "supporting_evidence": "Brief explanation of why"
        }}
    ]
}}"""
