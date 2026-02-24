# Implementation Plan: Personal Intel Summarizer

## Context

Building a personal automated intelligence summarizer that scans online sources (Tech/AI, Geopolitics, Finance), generates BLUF-format digests with cross-source analysis and tentative projections, and pushes them via Telegram Bot. Runs Dockerized on a Raspberry Pi / home server.

## Architecture

**Dockerized pipeline** (Python, scheduled via cron in container or external scheduler):
```
Ingest (RSS + GDELT + Serper)
  → Deduplicate (hash + cosine similarity)
  → Cluster (agglomerative, scipy)
  → Summarize (DeepSeek for bulk, Claude for analysis)
  → Cross-reference & Project (Claude Sonnet)
  → Format & Deliver (Telegram Bot)
```

**Key constraints**: No GPU, ~4GB RAM, SQLite, all LLM via API, ~$3-5/mo LLM cost.

## Extensibility Design

All major components use **abstract base classes + registry pattern** so new sources, delivery channels, LLM providers, and analyzers can be added by implementing an interface and registering:

- **Sources**: `BaseSource` ABC — add a new source by subclassing and dropping a file in `ingest/`
- **LLM Providers**: `BaseLLMProvider` ABC — swap/add any LLM provider (DeepSeek, Claude, OpenAI, Ollama, etc.)
- **Delivery Channels**: `BaseDelivery` ABC — add email, Discord, Slack, webhook alongside Telegram
- **Analyzers**: `BaseAnalyzer` ABC — plug in new analysis types (sentiment, topic-specific, etc.)
- **Processors**: `BaseProcessor` ABC — add new processing steps (entity extraction, etc.)

Each subsystem registers implementations via a simple dict registry in its `__init__.py`:
```python
# intel/ingest/__init__.py
SOURCES: dict[str, type[BaseSource]] = {}
def register_source(name: str):
    def decorator(cls): SOURCES[name] = cls; return cls
    return decorator
```

Config drives which implementations are active — no code changes needed to enable/disable components.

## Docker Setup

```
/workspace/
├── Dockerfile
├── docker-compose.yml
├── .env.example               # Template for secrets
├── .dockerignore
├── config.yaml
├── data/                      # Mounted volume for SQLite + logs
│   └── .gitkeep
├── pyproject.toml
├── intel/                     # Main package
│   └── ...
└── tests/
    └── ...
```

### Dockerfile (multi-stage, ARM-compatible)

```dockerfile
FROM python:3.12-slim AS base

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --no-cache-dir .

FROM python:3.12-slim
WORKDIR /app
COPY --from=base /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=base /usr/local/bin /usr/local/bin
COPY intel/ intel/
COPY config.yaml .

VOLUME /app/data
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "-m", "intel"]
CMD ["run"]
```

### docker-compose.yml

```yaml
services:
  intel:
    build: .
    env_file: .env
    volumes:
      - ./data:/app/data
      - ./config.yaml:/app/config.yaml:ro
    restart: "no"  # one-shot runs, scheduled externally

  # Scheduled runs via ofelia (cron-for-docker) or host cron
  scheduler:
    image: mcuadros/ofelia:latest
    depends_on: [intel]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    labels:
      ofelia.job-exec.intel-morning.schedule: "0 6 * * *"
      ofelia.job-exec.intel-morning.container: "intel"
      ofelia.job-exec.intel-morning.command: "python -m intel run"
      ofelia.job-exec.intel-evening.schedule: "0 18 * * *"
      ofelia.job-exec.intel-evening.container: "intel"
      ofelia.job-exec.intel-evening.command: "python -m intel run"
```

### .env.example
```
DEEPSEEK_API_KEY=
ANTHROPIC_API_KEY=
SERPER_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## Project Structure

```
/workspace/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .dockerignore
├── config.yaml
├── pyproject.toml
├── data/                        # Docker volume mount
│   └── .gitkeep
│
├── intel/                       # Main package
│   ├── __init__.py
│   ├── __main__.py              # CLI: python -m intel {run|ingest|init-db|test-telegram|stats}
│   ├── config.py                # Load config.yaml, resolve env vars, validate
│   ├── db.py                    # SQLite schema + migrations + query helpers
│   ├── models.py                # Dataclasses (Article, Cluster, Summary, etc.)
│   ├── pipeline.py              # Orchestrator: dynamically loads registered components
│   │
│   ├── ingest/                  # Source fetchers (extensible)
│   │   ├── __init__.py          # SOURCES registry
│   │   ├── base.py              # BaseSource ABC
│   │   ├── rss.py               # @register_source("rss")
│   │   ├── gdelt.py             # @register_source("gdelt")
│   │   ├── serper.py            # @register_source("serper")
│   │   └── scraper.py           # Article content extractor (trafilatura)
│   │
│   ├── process/                 # Processing steps (extensible)
│   │   ├── __init__.py          # PROCESSORS registry
│   │   ├── base.py              # BaseProcessor ABC
│   │   ├── embeddings.py        # Model2Vec (30MB, numpy-only, CPU-fast)
│   │   ├── dedup.py             # @register_processor("dedup")
│   │   └── cluster.py           # @register_processor("cluster")
│   │
│   ├── analyze/                 # Analysis steps (extensible)
│   │   ├── __init__.py          # ANALYZERS registry
│   │   ├── base.py              # BaseAnalyzer ABC
│   │   ├── crossref.py          # @register_analyzer("crossref")
│   │   ├── trends.py            # @register_analyzer("trends")
│   │   └── projections.py       # @register_analyzer("projections")
│   │
│   ├── synthesize/              # Summarization & reporting
│   │   ├── __init__.py
│   │   ├── summarizer.py        # Per-cluster BLUF summarization
│   │   └── report.py            # Format final Markdown digest
│   │
│   ├── deliver/                 # Delivery channels (extensible)
│   │   ├── __init__.py          # CHANNELS registry
│   │   ├── base.py              # BaseDelivery ABC
│   │   └── telegram.py          # @register_channel("telegram")
│   │
│   └── llm/                     # LLM providers (extensible)
│       ├── __init__.py          # PROVIDERS registry
│       ├── base.py              # BaseLLMProvider ABC
│       ├── deepseek.py          # @register_provider("deepseek")
│       ├── claude.py            # @register_provider("claude")
│       ├── prompts.py           # All prompt templates
│       └── batch.py             # Batching logic to minimize API calls
│
├── tests/
│   ├── conftest.py              # Shared fixtures
│   ├── test_config.py
│   ├── test_ingest.py
│   ├── test_dedup.py
│   ├── test_pipeline.py
│   └── fixtures/                # Sample feeds, API responses
│       ├── sample_rss.xml
│       └── sample_articles.json
│
└── scripts/
    └── setup_telegram.py        # One-time bot setup helper
```

## SQLite Schema (key tables)

- **articles**: url, title, content, source_name, source_type, topic, published_at, embedding (BLOB), content_hash, cluster_id
- **clusters**: topic, label, article_count, run_id
- **summaries**: cluster_id, depth (headline/briefing/deep_dive), what_happened, why_it_matters, whats_next, confidence
- **cross_references**: cluster_ids (JSON), ref_type (contradiction/pattern/implicit_connection), description, confidence
- **projections**: topic, description, timeframe, confidence, supporting_evidence, outcome (for accuracy tracking)
- **pipeline_runs**: started_at, finished_at, status, articles_fetched, llm_tokens_used, llm_cost_usd

## LLM Strategy

| Task | Model | Cost/Run |
|------|-------|----------|
| Cluster summarization (BLUF) | DeepSeek V3 | $0.014 |
| Cluster labeling | DeepSeek V3 | $0.001 |
| Entity extraction (Phase 3) | DeepSeek V3 | $0.005 |
| Cross-referencing (Phase 3) | Claude Sonnet | $0.03 |
| Projections (Phase 3) | Claude Sonnet | $0.02 |
| **Total per run** | | **~$0.03-0.07** |
| **Monthly (2 runs/day)** | | **~$2-4** |

## Digest Format (Telegram)

```
INTEL DIGEST — Feb 24, 2026 (Morning)
━━━━━━━━━━━━━━━━━━━━━━━━

TECH & AI

1. [CONFIRMED] OpenAI Releases GPT-5 API
   What: OpenAI launched GPT-5 with 1M context window.
   Why: Shifts competitive dynamics for smaller labs.
   Next: Expect rapid enterprise adoption within weeks.
   (Sources: Ars Technica, The Verge, TechCrunch)

GEOPOLITICS
...

CROSS-REFERENCES
- [PATTERN] EU AI Act enforcement (Tech) may create
  trade friction with the US (Geopolitics)...

PROJECTIONS
- [LIKELY, days] Expect AI companies to announce
  EU compliance strategies this week.

━━━━━━━━━━━━━━━━━━━━━━━━
15 articles | 6 clusters | $0.03
```

## Dependencies

```toml
[project]
name = "intel-summarizer"
version = "0.1.0"
requires-python = ">=3.11"

dependencies = [
    "pyyaml>=6.0",
    "numpy>=1.26",
    "feedparser>=6.0",
    "trafilatura>=1.12",
    "aiohttp>=3.9",
    "httpx>=0.27",              # DeepSeek API (OpenAI-compatible)
    "anthropic>=0.39",          # Claude API
    "model2vec>=0.4",           # 30MB embedding model, numpy-only
    "scipy>=1.12",              # Clustering
    "python-telegram-bot>=21.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "ruff>=0.8",
]
```

No PyTorch, no TensorFlow. ~50-60MB total disk. Runs on Pi (ARM).

## Phased Implementation

### Phase 1: End-to-End Skeleton (first)
Docker + working pipeline from RSS → summary → Telegram.

1. **Docker setup**: Dockerfile (multi-stage, ARM-compatible), docker-compose.yml, .env.example, .dockerignore
2. **Project scaffolding**: pyproject.toml, config.yaml, directory structure with all `__init__.py`
3. **Base classes**: `BaseSource`, `BaseLLMProvider`, `BaseDelivery` ABCs with registry decorators
4. `config.py` — load YAML, resolve `${ENV_VARS}`, validate
5. `db.py` — SQLite schema creation, basic insert/query helpers
6. `models.py` — Article, Cluster, Summary, PipelineRun dataclasses
7. `ingest/rss.py` — fetch RSS feeds with feedparser
8. `ingest/scraper.py` — extract article text with trafilatura
9. `llm/deepseek.py` — DeepSeek provider (OpenAI-compatible endpoint)
10. `llm/prompts.py` — BLUF summarization prompt
11. `synthesize/summarizer.py` — batch articles → BLUF summaries
12. `synthesize/report.py` — format digest as Markdown
13. `deliver/telegram.py` — send to Telegram with message splitting
14. `pipeline.py` — wire ingest → summarize → deliver (uses registries)
15. `__main__.py` — CLI with `run`, `init-db`, `test-telegram` commands

### Phase 2: Dedup, Clustering, Multi-Source
Make it smart about what it processes.

1. `process/embeddings.py` — Model2Vec embedding generation
2. `process/dedup.py` — hash + cosine similarity dedup
3. `process/cluster.py` — agglomerative clustering, LLM cluster labels
4. `ingest/gdelt.py` — GDELT Doc 2.0 API fetcher
5. `ingest/serper.py` — Serper.dev news search fetcher
6. All 3 topics active in config with full source lists
7. Per-cluster summarization (not per-article)

### Phase 3: Analysis Layer
The "reading between the lines" differentiator.

1. `llm/claude.py` — Claude Sonnet provider
2. `analyze/crossref.py` — contradiction/pattern detection
3. `analyze/projections.py` — near-term projections with calibrated confidence
4. `analyze/trends.py` — developing story detection across runs
5. `process/entities.py` — LLM-based entity extraction
6. Cross-reference and projections sections in digest

### Phase 4: Hardening
Make it reliable for daily unattended use.

1. Retry logic with exponential backoff for API calls
2. Graceful degradation (if LLM down → send raw article list)
3. Cost tracking in pipeline_runs table
4. docker-compose scheduler setup (ofelia or host cron)
5. Projection accuracy scoring via Telegram `/score` command
6. Basic test suite with saved fixtures
7. Health check endpoint (optional: simple HTTP health for monitoring)

## Verification

1. `docker compose build` — builds image (test ARM compatibility)
2. `docker compose run intel init-db` — creates SQLite DB in mounted volume
3. `docker compose run intel test-telegram` — sends test message
4. `docker compose run intel ingest` — fetches articles, shows count
5. `docker compose run intel run` — full pipeline, digest appears in Telegram
6. `docker compose run intel stats` — shows run history and costs
