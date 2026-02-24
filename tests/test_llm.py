"""Tests for LLM providers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from intel.llm.openai_compat import OpenAICompatibleProvider


@pytest.fixture
def openai_provider():
    return OpenAICompatibleProvider(
        api_key="test-key",
        base_url="http://localhost:9999",
        default_model="test-model",
    )


def _mock_openai_response(content="test response", model="test-model"):
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20},
    }


@pytest.mark.asyncio
@patch("intel.llm.openai_compat.httpx.AsyncClient")
async def test_openai_compat_complete(mock_client_cls, openai_provider):
    """OpenAI-compatible provider makes correct API call."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = _mock_openai_response("hello world")
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client_cls.return_value = mock_client

    # Patch out cost tracking to avoid pipeline import issues
    with patch.object(openai_provider, "_track_cost"):
        response = await openai_provider.complete("test prompt", system="sys")

    assert response.text == "hello world"
    assert response.input_tokens == 10
    assert response.output_tokens == 20

    # Verify the API was called with correct payload
    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert payload["model"] == "test-model"
    assert len(payload["messages"]) == 2
    assert payload["messages"][0]["role"] == "system"
    assert payload["messages"][1]["content"] == "test prompt"


@pytest.mark.asyncio
@patch("intel.llm.openai_compat.httpx.AsyncClient")
async def test_openai_compat_no_system(mock_client_cls, openai_provider):
    """System message is omitted when empty."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = _mock_openai_response()
    mock_resp.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_resp
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client_cls.return_value = mock_client

    with patch.object(openai_provider, "_track_cost"):
        await openai_provider.complete("prompt only")

    call_args = mock_client.post.call_args
    payload = call_args.kwargs.get("json") or call_args[1].get("json")
    assert len(payload["messages"]) == 1
    assert payload["messages"][0]["role"] == "user"
