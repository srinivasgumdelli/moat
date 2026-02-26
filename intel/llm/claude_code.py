"""Claude Code CLI provider — uses `claude -p` for headless LLM calls."""

from __future__ import annotations

import asyncio
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

# Module-level hint for the current task — set by callers before complete()
_current_task: str = ""


def set_current_task(task: str) -> None:
    """Set the current task name for JSON schema selection."""
    global _current_task
    _current_task = task


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
        schema = TASK_SCHEMAS.get(_current_task, "")
        if schema:
            cmd.extend(["--json-schema", schema])

        logger.debug("Running: claude -p --model %s (prompt: %d chars)", model_name, len(prompt))

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
            logger.error("claude -p timed out after %ds", self.timeout)
            raise TimeoutError(f"claude -p timed out after {self.timeout}s")

        if proc.returncode != 0:
            err = stderr.decode().strip()
            logger.error("claude -p failed (rc=%d): %s", proc.returncode, err[:500])
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

        response = LLMResponse(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model=model_used,
            cost_usd=cost,
        )
        self._track_cost(response)
        return response
