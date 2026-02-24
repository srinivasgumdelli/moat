# Automated Intelligence Summarizer — Idea Analysis & Implementation Plan

## 1. The Idea

An automated system that scans relevant online sources, generates digestible reports at configurable detail levels, cross-links events across sources to "read between the lines," and produces tentative projections about near-term developments.

---

## 2. Competitive Landscape

### Existing Open-Source Projects

| Project | What It Does | Tech Stack | Relevance |
|---------|-------------|------------|-----------|
| **[Taranis AI](https://github.com/taranis-ai/taranis-ai)** | OSINT tool: scrapes RSS/Twitter/email, NLP enrichment, analyst workflows, structured reports | Python, Vue.js, Flask, PostgreSQL | High — closest to our vision, but focused on cybersecurity |
| **[GPT Researcher](https://github.com/assafelovic/gpt-researcher)** | Autonomous deep research agent, multi-source, 2K+ word reports | Python, LangChain, multi-LLM | High — great research pattern, but on-demand not continuous |
| **[news-trend-analysis](https://github.com/davidjosipovic/news-trend-analysis)** | Sentiment (FinBERT), topic modeling (BERTopic), summaries (DistilBART), daily pipeline | Python, Streamlit, FastAPI | High — good extraction pipeline reference |
| **[Graphiti](https://github.com/getzep/graphiti)** | Temporal knowledge graphs for AI agents | Python, Neo4j | Medium — useful for the cross-linking layer |
| **[OpenForecaster](https://openforecaster.github.io/)** | Generates forecasting questions from news, trains prediction models | Python, LLM + RL | Medium — the projection capability |
| **[LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research)** | Deep research via Firecrawl + LangChain agents | Python, LangChain | Medium — reference architecture |

### Commercial Products

| Product | Approach | Gap vs. Our Idea |
|---------|----------|------------------|
| **Feedly Leo** | Trainable AI filtering, business event tracking | No cross-source synthesis |
| **Perplexity Discover** | AI search + personalized feed | Reactive, not proactive briefings |
| **Recorded Future** | Enterprise threat intelligence, 200B+ node graph | $$$, security-focused only |
| **Primer AI** | NLP for intelligence analysis, multilingual | Government/enterprise only |
| **Ground News** | Multi-source bias comparison | No AI synthesis, no projection |
| **Morning Brew / The Skimm** | Human-written daily digests | No personalization, no AI |
| **NewsWhip Spike** | Predictive engagement analytics | Media monitoring, not analysis |

### Key Insight: The Gap

**No existing product combines all three**: (1) multi-source aggregation, (2) cross-source inference/"reading between the lines," and (3) calibrated tentative projections. Products either aggregate OR analyze OR predict — never all three in an integrated pipeline with transparent confidence levels.

---

## 3. Technical Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     User Interface Layer                     │
│  Email Digest (L1/L2) | Web Dashboard (L3) | API/CLI        │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                  Analysis & Synthesis Layer                   │
│                                                              │
│  Multi-Doc Summarizer | Trend Analyzer | SAT Engine          │
│  Bias Detector | Projection Engine | Contradiction Detector  │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                   Knowledge Graph Layer                       │
│                                                              │
│  Entity Store (Neo4j) | Event Store (TimeSeries)             │
│  Embedding Index (FAISS/pgvector) | Source Registry           │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                    Extraction Layer                           │
│                                                              │
│  NER + Entity Linking | Event Extractor | Sentiment/Stance   │
│  Relation Extractor | Temporal Resolver | Claim Decomposer   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────┴───────────────────────────────────┐
│                     Ingestion Layer                           │
│                                                              │
│  RSS/Atom Feeds | Web Scraper (Crawl4AI) | News APIs         │
│  GDELT Feed | Social APIs (Reddit) | Document Dedup          │
└─────────────────────────────────────────────────────────────┘
```

### Data Ingestion Options

| Source Type | Tool | Cost | Notes |
|-------------|------|------|-------|
| **RSS/Atom feeds** | feedparser (Python) | Free | Best for curated sources |
| **News search** | Serper.dev | $0.001/query | Fast, cheap Google News scraping |
| **News API** | NewsAPI.org | Free tier: 100 req/day | 150K+ sources, structured |
| **Global events** | GDELT | Free | Updates every 15 min, 100+ languages |
| **Web scraping** | Crawl4AI | Free (self-hosted) | Local-first, LLM-ready markdown |
| **Web scraping (managed)** | Firecrawl | API pricing | Zero-infra, structured output |
| **Social (Reddit)** | Reddit API | Free tier available | Community discussions/sentiment |

### LLM Strategy (Tiered)

| Task | Model | Cost | Rationale |
|------|-------|------|-----------|
| **High-volume extraction** (NER, classification) | Llama 3 8B (local) or Haiku 4.5 | ~$0.50/M tokens | Fast, cheap, good enough for structured extraction |
| **Summarization** | Claude Sonnet 4.5 or DeepSeek V3 | $3/M or $0.15/M tokens | Good quality-to-cost ratio |
| **Deep analysis & synthesis** | Claude Opus 4.6 | $5/M input tokens | Best reasoning for cross-linking and projection |
| **Batch processing** | Claude Batch API | 50% discount | Stack with prompt caching for up to 95% savings |

### Knowledge Graph & Storage

| Component | Tool | Why |
|-----------|------|-----|
| **Knowledge graph** | Neo4j | Mature, Cypher query language, GDS algorithms (PageRank, community detection) |
| **Vector embeddings** | pgvector (PostgreSQL) or Qdrant | Semantic search for cross-linking |
| **Document store** | PostgreSQL | Source of truth for articles |
| **Time series** | TimescaleDB | Event frequency, sentiment over time |
| **Search** | Meilisearch | Fast full-text + faceted search |
| **Orchestration** | Dagster or Prefect | Python-native, modern, good for data pipelines |

---

## 4. NLP & AI Techniques

### Multi-Document Summarization

- **Hierarchical approach**: Extract key sentences per document (extractive), then use LLM to synthesize across documents (abstractive)
- **Contradiction detection**: Use NLI models (DeBERTa-v3-large MNLI) to identify when sources disagree
- **Configurable verbosity**: Generate at L3 depth, then use LLM to compress to L2 and L1 — easier than expanding

### Cross-Linking ("Reading Between the Lines")

1. **Named Entity Recognition**: spaCy + GLiNER for zero-shot entity types
2. **Entity Linking**: REL (Radboud) + Wikidata for canonical IDs
3. **Relation Extraction**: REBEL model for structured triples, LLM for nuanced relations
4. **Bridge Entity Detection**: Find entities connecting separate knowledge graph subgraphs
5. **Temporal Co-occurrence**: Association rule mining on event sequences
6. **Embedding Proximity**: Flag semantically similar events from different contexts
7. **Network Motif Detection**: Find recurring structural patterns (e.g., revolving-door patterns)

### Event Extraction Pipeline

```
For each incoming document:
  1. Extract events using SRL + LLM template filling
  2. Resolve temporal expressions to absolute dates (HeidelTime)
  3. Link entities to canonical IDs
  4. Insert into event store with (entity, event_type, date, source, confidence)
  5. Update entity timelines
  6. Run anomaly detection on event frequency/type changes
```

### Trend Analysis & Projection

- **Sentiment tracking**: Aspect-Based Sentiment Analysis per entity/topic over time
- **Narrative detection**: BERTopic dynamic topic modeling to track emerging/shifting topics
- **Burst detection**: Kleinberg's algorithm for sudden term/topic frequency spikes
- **Weak signal detection**: Monitor low-frequency but growing semantic clusters
- **Structured Analytic Techniques (automatable)**:
  - Analysis of Competing Hypotheses (ACH) — LLM generates hypotheses, NLI scores evidence
  - Indicators & Warnings — pre-define indicators, monitor event streams
  - Scenario planning — LLM generates scenarios, system tracks evidence alignment
  - Devil's Advocacy — LLM argues against leading hypothesis

### Bias & Reliability

- **Source credibility**: Multi-dimensional scoring (accuracy, timeliness, expertise, independence)
- **External data**: NewsGuard, Media Bias/Fact Check, GDELT metadata
- **Bias detection**: Lexical indicators, framing analysis, coverage gap analysis, quote attribution
- **Balanced presentation**: Show perspectives across political/geographic spectrum with explicit agreement/disagreement points

---

## 5. Report Format & UX Design

### Information Hierarchy (Three Tiers)

| Level | Name | Length | Content | Delivery |
|-------|------|--------|---------|----------|
| **L1** | Executive Flash | 1-2 sentences | BLUF: what + why it matters | Push notification, email subject |
| **L2** | Daily Digest | 1-2 paragraphs/topic | BLUF + context + outlook | Email body, dashboard summary |
| **L3** | Deep Dive | Full analysis | Sources, cross-refs, confidence, timeline | Web dashboard, API |

### BLUF Format (every item)

Every summary follows the intelligence briefing format:
1. **What** happened (fact)
2. **Why** it matters (significance)
3. **What's next** (outlook, with confidence level)

### Confidence Display

Adopt the Intelligence Community's calibrated uncertainty language:

| Level | Badge | Language |
|-------|-------|---------|
| High confidence | Confirmed | "Multiple independent sources confirm..." |
| Medium-high | Likely | "Evidence strongly suggests..." |
| Medium | Developing | "Some evidence indicates..." |
| Low | Speculative | "Based on limited/indirect evidence..." |
| Unverified | Unverified | "Reported by single source, not corroborated" |

### Key Design Principles

1. **BLUF always** — lead with the bottom line
2. **Depth on demand** — default to shortest useful version; let users pull more
3. **Source transparency** — never present a claim without showing where it came from
4. **Epistemic honesty** — confidence levels are visible, not hidden
5. **Habit over features** — reliable daily email > feature-rich dashboard nobody visits
6. **Diversity by design** — resist filter bubbles; surface unexpected-but-relevant signals
7. **Cross-reference as differentiator** — the unique value is what emerges from comparing across sources

---

## 6. Unique Value Proposition

Three pillars that differentiate from everything on the market:

1. **"Reading between the lines"** — Cross-referencing sources to surface what no single source reports: contradictions, patterns, missing context, and implied developments. This is intelligence analysis, not just summarization.

2. **Epistemic transparency** — Every claim tagged with confidence level, source evidence, and analytical method. Users always know *how much* to trust a given insight.

3. **Configurable depth with seamless drill-down** — One product serving the 30-second scan, the 5-minute briefing, and the 30-minute research session.

---

## 7. Implementation Roadmap

### Phase 1 — MVP (Months 1-3)
**Goal**: Daily email digest with web companion for one domain

- Source ingestion pipeline (20-50 curated RSS feeds + 1-2 news APIs)
- BLUF summaries (What/Why/What's Next format)
- Daily email digest: 5-8 items, 5-minute read
- Web companion for expanded L2/L3 views with source links
- Basic topic selection during onboarding
- Simple confidence indicators (Confirmed / Developing / Speculative)
- Cross-reference callout boxes when sources diverge

### Phase 2 — Interactivity (Months 4-6)
**Goal**: Personalization, feedback loops, expanded coverage

- Interactive web dashboard with entity pages and timelines
- User feedback (thumbs up/down, more/less like this)
- 100+ sources, user-addable custom sources
- Push notifications for significant developments
- 2-3 additional topic domains

### Phase 3 — Intelligence Layer (Months 7-12)
**Goal**: Knowledge graph, pattern detection, deeper analysis

- Visual knowledge graph (entity-relationship maps)
- AI-generated timeline narratives ("The story so far...")
- Pattern and contradiction detection
- API/CLI access for power users
- Mobile app with offline reading

### Phase 4 — Platform (Year 2)
**Goal**: Collaboration, custom agents, prediction tracking

- Team sharing and collaborative annotation
- Custom analysis agents ("Track all M&A in fintech")
- Prediction accuracy tracking (public track record)
- Multi-language source ingestion
- Generative briefing customization ("this week's AI news from a regulatory angle")

---

## 8. Recommended Tech Stack

| Layer | Technology | Alternative |
|-------|-----------|-------------|
| **Language** | Python 3.12+ | — |
| **Web framework** | FastAPI | Django |
| **Email** | Resend or SendGrid | Amazon SES |
| **Frontend** | Next.js + React | SvelteKit |
| **Database** | PostgreSQL + pgvector | — |
| **Knowledge graph** | Neo4j | ArangoDB |
| **Time series** | TimescaleDB extension | InfluxDB |
| **Search** | Meilisearch | Elasticsearch |
| **Vector store** | pgvector (start), Qdrant (scale) | Pinecone |
| **LLM (extraction)** | Haiku 4.5 or Llama 3 8B | DeepSeek |
| **LLM (synthesis)** | Claude Sonnet 4.5 | GPT-4o |
| **LLM (deep analysis)** | Claude Opus 4.6 | — |
| **NER** | spaCy + GLiNER | — |
| **Topic modeling** | BERTopic | — |
| **Sentiment** | DeBERTa-v3 fine-tuned | FinBERT |
| **Scraping** | Crawl4AI (self-hosted) | Firecrawl (managed) |
| **Orchestration** | Dagster | Prefect, Airflow |
| **Deployment** | Docker Compose → Kubernetes | Railway, Fly.io |
| **CI/CD** | GitHub Actions | — |

---

## 9. Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **LLM hallucination** | Extractive pre-filter + mandatory citations + FactScore verification |
| **Entity linking errors** | Confidence thresholds + human review queue for low-confidence links |
| **Projection overconfidence** | Mandatory uncertainty quantification + counter-argument generation |
| **Bias in the system** | Source diversity monitoring + coverage gap alerts |
| **Cost at scale** | Tiered models: cheap for extraction, expensive only for synthesis |
| **Legal/copyright** | Fair use summaries with links to originals; no full-text reproduction |
| **Adversarial manipulation** | Coordinated narrative detection + source reputation tracking |
| **Artifact lesson** | Start narrow (1 domain), validate engagement before expanding |

---

## 10. Estimated Monthly Costs (MVP)

| Component | Estimate |
|-----------|----------|
| LLM APIs (Haiku extraction + Sonnet synthesis, ~50 articles/day) | $30-80/mo |
| News APIs (Serper, NewsAPI) | $0-50/mo |
| Infrastructure (VPS for pipeline + DB) | $50-100/mo |
| Email delivery (Resend) | $0-20/mo |
| Domain + hosting (web frontend) | $10-20/mo |
| **Total MVP** | **$90-270/mo** |

---

## 11. References & Resources

### Open Source Projects
- [Taranis AI](https://github.com/taranis-ai/taranis-ai) — OSINT news intelligence platform
- [GPT Researcher](https://github.com/assafelovic/gpt-researcher) — Autonomous deep research agent
- [news-trend-analysis](https://github.com/davidjosipovic/news-trend-analysis) — NLP news analysis pipeline
- [Graphiti](https://github.com/getzep/graphiti) — Temporal knowledge graphs
- [OpenForecaster](https://openforecaster.github.io/) — News-based prediction models
- [Crawl4AI](https://github.com/unclecode/crawl4ai) — LLM-ready web scraping
- [BERTopic](https://github.com/MaartenGr/BERTopic) — Dynamic topic modeling
- [GDELT Project](https://www.gdeltproject.org/) — Global events database (free, updates every 15 min)

### Key Academic References
- Heuer (1999) — *Psychology of Intelligence Analysis* (CIA, freely available)
- *A Tradecraft Primer: Structured Analytic Techniques* (US Government)
- ICD 203 — Intelligence Community standard for expressing uncertainty
- Grootendorst (2022) — BERTopic: Neural topic modeling
- Kleinberg (2003) — Bursty and Hierarchical Structure in Streams

### Bias & Credibility Data
- [NewsGuard](https://www.newsguardtech.com/) — Source credibility ratings (API available)
- [Media Bias/Fact Check](https://mediabiasfactcheck.com/) — Bias + factual reporting ratings
- [AllSides](https://www.allsides.com/) — Multi-perspective news comparison
- [Ground News](https://ground.news/) — Source bias visualization
