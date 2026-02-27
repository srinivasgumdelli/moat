# Intel Summarizer

Automated intelligence digest pipeline that ingests news from multiple sources, deduplicates and clusters related articles, generates BLUF (Bottom Line Up Front) summaries via LLM, and delivers a styled PDF digest to Telegram.

## How It Works

```
RSS / GDELT / Serper  -->  Dedup  -->  Cluster  -->  Summarize (LLM)
                                                          |
                                          Analyze: crossrefs, projections, trends
                                                          |
                                          Format: PDF + Telegram HTML
                                                          |
                                              Deliver via Telegram Bot
```

**Pipeline stages:**

1. **Ingest** — Fetches articles from RSS feeds, GDELT events, and Serper search API across configurable topics (tech, geopolitics, finance). All source/topic combinations run in parallel.
2. **Dedup** — Removes exact duplicates (content hash) and near-duplicates (cosine similarity on embeddings).
3. **Cluster** — Groups related articles using agglomerative clustering on [potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) embeddings.
4. **Summarize** — Generates BLUF summaries per cluster using Claude, DeepSeek, or local Ollama. Runs up to 10 clusters concurrently.
5. **Analyze** — Cross-references clusters across topics, generates near-term projections, and tracks developing stories across runs. All analyzers run in parallel.
6. **Deliver** — Sends a styled PDF attachment to Telegram with a short caption, falling back to chunked HTML messages if PDF generation fails.

Everything is persisted in SQLite (articles, clusters, summaries, runs, costs).

## Quick Start

### Prerequisites

- Python 3.11+
- A Telegram bot token ([create one via @BotFather](https://t.me/BotFather))
- At least one LLM provider: Anthropic API key, DeepSeek API key, or local Ollama

### Setup

```bash
# Clone and install
git clone https://github.com/srinivasgumdelli/intel-summarizer.git
cd intel-summarizer
pip install -e ".[dev]"

# Configure credentials
cp .env.example .env
# Edit .env with your API keys and Telegram credentials

# Find your Telegram chat ID
python scripts/setup_telegram.py <YOUR_BOT_TOKEN>

# Initialize the database
python -m intel init-db

# Run the pipeline
python -m intel run
```

### Docker

```bash
# Standard run (uses API-based LLM providers)
docker compose run intel run

# With local Ollama (no API keys needed)
docker compose --profile local-llm up -d ollama
docker compose exec ollama ollama pull llama3.2:3b
docker compose run -v ./config.local.yaml:/app/config.yaml:ro intel run

# Scheduled runs (6 AM and 6 PM daily)
docker compose up -d scheduler
```

## Configuration

All configuration lives in `config.yaml` with `${ENV_VAR}` substitution from `.env`.

### LLM Providers

| Provider | Config key | Notes |
|----------|-----------|-------|
| Claude (API) | `claude` | Anthropic API, best quality |
| Claude Code CLI | `claude_cli` | Uses `claude -p`, no API key needed if CLI is authenticated |
| DeepSeek | `deepseek` | OpenAI-compatible, cost-effective |
| Ollama | `ollama` | Local, free, requires `docker compose --profile local-llm` |

Route tasks to providers in `llm.tasks`:

```yaml
llm:
  tasks:
    summarize: { provider: "claude_cli" }
    crossref: { provider: "claude_cli" }
    projections: { provider: "claude_cli" }
    deep_dive: { provider: "claude_cli", model: "opus" }
```

### Sources

- **RSS** — Enabled by default with feeds for tech, geopolitics, and finance
- **GDELT** — Global event database (disabled by default)
- **Serper** — Google search API for targeted queries (disabled by default, requires API key)

### Delivery

The digest is delivered as a styled **PDF attachment** via Telegram by default (`deliver.telegram.pdf_digest: true`). The PDF includes:
- Color-coded topic sections (blue for tech, red for geopolitics, green for finance)
- Confidence badges (CONFIRMED, LIKELY, DEVELOPING, SPECULATIVE)
- Cross-references, projections, and developing stories sections
- Article and cost statistics footer

Set `pdf_digest: false` to fall back to chunked Telegram HTML messages.

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `pipeline.max_articles_per_topic` | 30 | Cap articles per topic before clustering |
| `pipeline.max_article_age_hours` | 24 | Discard articles older than this |
| `pipeline.max_concurrent_summaries` | 10 | Parallel LLM calls for summarization |
| `process.cluster.distance_threshold` | 0.6 | Lower = tighter clusters |
| `deliver.telegram.pdf_digest` | true | Send PDF attachment vs HTML text |

## CLI Commands

```bash
python -m intel run             # Full pipeline: ingest -> summarize -> deliver
python -m intel ingest          # Fetch articles only (test sources)
python -m intel init-db         # Initialize/reset the SQLite database
python -m intel test-telegram   # Send a test message to verify Telegram config
python -m intel stats           # Show recent pipeline run statistics
```

## Project Structure

```
intel/
  __main__.py          CLI entrypoint
  pipeline.py          Pipeline orchestrator
  config.py            YAML + .env config loader
  db.py                SQLite schema and queries
  models.py            Dataclasses (Article, Cluster, Summary, etc.)
  ingest/              Source fetchers (RSS, GDELT, Serper)
  process/             Dedup, clustering, embeddings
  synthesize/          Summarizer, PDF renderer, HTML report formatter
  analyze/             Cross-references, projections, trend detection
  deliver/             Telegram delivery (PDF + text)
  llm/                 Provider abstraction (Anthropic, OpenAI-compat, Claude CLI)
tests/                 61 pytest tests
config.yaml            Main configuration
config.local.yaml      Ollama-only config for local dev
```

## Tests

```bash
# Run all tests
pytest

# Run specific test modules
pytest tests/test_pdf.py tests/test_telegram.py -v
```

## License

Private project.
