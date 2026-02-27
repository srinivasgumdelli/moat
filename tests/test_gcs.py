"""Tests for GCS upload with signed URLs (all network calls mocked)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from intel.deliver.gcs import upload_html

_FAKE_EMAIL = "sa@project.iam.gserviceaccount.com"
_FAKE_TOKEN = "fake-token"
_FAKE_SIG = b"x" * 64


@pytest.mark.asyncio
async def test_upload_returns_signed_url():
    """Successful upload returns a signed URL."""
    mock_get_token = AsyncMock(return_value=(_FAKE_TOKEN, _FAKE_EMAIL))
    mock_sign = AsyncMock(return_value=_FAKE_SIG)

    # Mock the httpx POST for GCS upload (used inside `async with`)
    mock_response = httpx.Response(200, json={"name": "digest.html"})
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("intel.deliver.gcs._get_access_token", mock_get_token),
        patch("intel.deliver.gcs._sign_blob", mock_sign),
        patch("intel.deliver.gcs.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await upload_html("<html>test</html>", "my-bucket", "digest.html")

    assert result is not None
    assert "storage.googleapis.com" in result
    assert "my-bucket" in result
    assert "X-Goog-Signature=" in result
    assert "X-Goog-Expires=43200" in result


@pytest.mark.asyncio
async def test_empty_bucket_returns_none():
    """Empty bucket name returns None without making network calls."""
    result = await upload_html("<html>test</html>", "", "digest.html")
    assert result is None


@pytest.mark.asyncio
async def test_metadata_unreachable_returns_none():
    """ConnectError from metadata server returns None gracefully."""
    side_effect = httpx.ConnectError("no metadata")
    with patch("intel.deliver.gcs._get_access_token", side_effect=side_effect):
        result = await upload_html("<html>test</html>", "bucket", "digest.html")
    assert result is None


@pytest.mark.asyncio
async def test_gcs_403_returns_none():
    """GCS 403 response returns None."""
    mock_get_token = AsyncMock(return_value=(_FAKE_TOKEN, _FAKE_EMAIL))
    mock_response = httpx.Response(403, text="Forbidden")
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("intel.deliver.gcs._get_access_token", mock_get_token),
        patch("intel.deliver.gcs.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await upload_html("<html>test</html>", "bucket", "digest.html")

    assert result is None


@pytest.mark.asyncio
async def test_sign_blob_failure_returns_none():
    """Failed signBlob returns None (upload succeeds but signing fails)."""
    mock_get_token = AsyncMock(return_value=(_FAKE_TOKEN, _FAKE_EMAIL))
    mock_sign = AsyncMock(side_effect=httpx.HTTPStatusError(
        "403", request=httpx.Request("POST", "http://x"), response=httpx.Response(403),
    ))

    mock_response = httpx.Response(200, json={"name": "digest.html"})
    mock_client = AsyncMock()
    mock_client.post.return_value = mock_response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch("intel.deliver.gcs._get_access_token", mock_get_token),
        patch("intel.deliver.gcs._sign_blob", mock_sign),
        patch("intel.deliver.gcs.httpx.AsyncClient", return_value=mock_client),
    ):
        result = await upload_html("<html>test</html>", "bucket", "digest.html")

    assert result is None
