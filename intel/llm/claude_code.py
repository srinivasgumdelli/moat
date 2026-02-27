"""Claude Code CLI provider — uses `claude -p` for headless LLM calls."""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging

from intel.llm import register_provider
from intel.llm.base import BaseLLMProvider, LLMResponse

logger = logging.getLogger(__name__)

SUMMARY_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "label": {"type": "string"},
        "confidence": {
            "type": "string",
            "enum": ["confirmed", "likely", "developing", "speculative"],
        },
        "what_happened": {"type": "string"},
        "why_it_matters": {"type": "string"},
        "whats_next": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["confidence", "what_happened", "why_it_matters", "whats_next"],
})

CROSSREF_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "cross_references": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "cluster_ids": {"type": "array", "items": {"type": "integer"}},
                    "ref_type": {"type": "string"},
                    "description": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["cluster_ids", "ref_type", "description", "confidence"],
            },
        },
    },
    "required": ["cross_references"],
})

PROJECTIONS_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "projections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "description": {"type": "string"},
                    "timeframe": {"type": "string"},
                    "confidence": {"type": "string"},
                    "supporting_evidence": {"type": "string"},
                },
                "required": ["topic", "description", "timeframe", "confidence"],
            },
        },
    },
    "required": ["projections"],
})

# Map LLM task names to JSON schemas for structured output
TASK_SCHEMAS: dict[str, str] = {
    "summarize": SUMMARY_SCHEMA,
    "label_clusters": "",
    "crossref": CROSSREF_SCHEMA,
    "projections": PROJECTIONS_SCHEMA,
    "deep_dive": SUMMARY_SCHEMA,
}

# Coroutine-safe task hint — each asyncio task gets its own value
_current_task: contextvars.ContextVar[str] = contextvars.ContextVar(
    "_current_task", default="",
)


def set_current_task(task: str) -> None:
    """Set the current task name for JSON schema selection (coroutine-safe)."""
    _current_task.set(task)


@register_provider("claude_code")
class ClaudeCodeProvider(BaseLLMProvider):
    """Provider that shells out to `claude -p` CLI."""

    def __init__(self, **kwargs):
        # claude_code doesn't need api_key/base_url but the ABC requires them
        super().__init__(
            api_key=kwargs.get("api_key", ""),
            base_url=kwargs.get("base_url", ""),
            default_model=kwargs.get("default_model", "sonnet"),
            max_retries=kwargs.get("max_retries", 2),
            timeout=kwargs.get("timeout", 120),
        )
        self.model_alias = kwargs.get("default_model", "sonnet")

    @property
    def provider_name(self) -> str:
        return "claude_code"

    async def complete(
        self,
        prompt: str,
        system: str = "",
        model: str | None = None,
        temperature: float = 0.3,
        max_tokens: int = 2000,
    ) -> LLMResponse:
        model_name = model or self.model_alias
        cmd = ["claude", "-p", "--output-format", "json", "--model", model_name]

        if system:
            cmd.extend(["--system-prompt", system])

        # Add JSON schema for structured output when available
        schema = TASK_SCHEMAS.get(_current_task.get(), "")
        if schema:
            cmd.extend(["--json-schema", schema])

        task = _current_task.get() or "unknown"
        logger.info(
            "[%s] Starting claude -p --model %s (%d chars)",
            task, model_name, len(prompt),
        )
        t0 = asyncio.get_event_loop().time()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=prompt.encode()),
                timeout=self.timeout,
            )
        except asyncio.TimeoutError:
            elapsed = asyncio.get_event_loop().time() - t0
            logger.error(
                "[%s] claude -p timed out after %.1fs", task, elapsed,
            )
            raise TimeoutError(f"claude -p timed out after {self.timeout}s")

        elapsed = asyncio.get_event_loop().time() - t0

        if proc.returncode != 0:
            err = stderr.decode().strip()
            logger.error(
                "[%s] claude -p failed (rc=%d, %.1fs): %s",
                task, proc.returncode, elapsed, err[:500],
            )
            raise RuntimeError(f"claude -p exited with code {proc.returncode}: {err[:200]}")

        raw = stdout.decode()

        # --output-format json wraps the response in a JSON envelope
        try:
            envelope = json.loads(raw)
            text = envelope.get("result", raw)
            cost = envelope.get("cost_usd", 0.0)
            input_tokens = envelope.get("input_tokens", 0)
            output_tokens = envelope.get("output_tokens", 0)
            model_used = envelope.get("model", model_name)
        except json.JSONDecodeError:
            text = raw.strip()
            cost = 0.0
            input_tokens = 0
            output_tokens = 0
            model_used = model_name

        logger.info(
            "[%s] claude -p done in %.1fs (%d+%d tokens, $%.4f)",
            task, elapsed, input_tokens, output_tokens, cost,
        )

        response = LLMResponse(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model_used,
            cost_usd=cost,
        )
        self._track_cost(response)
        return response
