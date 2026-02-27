"""Upload HTML digest to GCS and generate signed URLs for private access."""

from __future__ import annotations

import base64
import hashlib
import logging
from datetime import datetime
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

# GCS JSON API endpoints
_METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/"
    "instance/service-accounts/default/token"
)
_METADATA_EMAIL_URL = (
    "http://metadata.google.internal/computeMetadata/v1/"
    "instance/service-accounts/default/email"
)
_GCS_UPLOAD_URL = "https://storage.googleapis.com/upload/storage/v1/b/{bucket}/o"
_IAM_SIGN_URL = (
    "https://iamcredentials.googleapis.com/v1/"
    "projects/-/serviceAccounts/{email}:signBlob"
)

# 12-hour signed URL validity
_SIGNED_URL_EXPIRY_SECONDS = 12 * 60 * 60


async def _get_access_token() -> tuple[str, str]:
    """Get access token and service account email from GCE metadata server.

    Returns (access_token, service_account_email).
    """
    async with httpx.AsyncClient(timeout=5) as client:
        token_resp = await client.get(
            _METADATA_TOKEN_URL,
            headers={"Metadata-Flavor": "Google"},
        )
        token_resp.raise_for_status()
        access_token = token_resp.json()["access_token"]

        email_resp = await client.get(
            _METADATA_EMAIL_URL,
            headers={"Metadata-Flavor": "Google"},
        )
        email_resp.raise_for_status()
        email = email_resp.text.strip()

    return access_token, email


async def _sign_blob(access_token: str, email: str, blob: bytes) -> bytes:
    """Sign a blob using the IAM signBlob API (requires iam.serviceAccounts.signBlob)."""
    url = _IAM_SIGN_URL.format(email=quote(email, safe=""))
    payload = {"payload": base64.b64encode(blob).decode()}

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        resp.raise_for_status()
        return base64.b64decode(resp.json()["signedBlob"])


async def upload_html(
    html_content: str,
    bucket: str,
    object_name: str,
) -> str | None:
    """Upload HTML to GCS and return a 12-hour signed URL.

    Returns the signed URL on success, None on failure.
    Gracefully handles missing metadata server (local dev) and GCS errors.
    """
    if not bucket:
        logger.warning("GCS bucket not configured — skipping HTML upload")
        return None

    try:
        access_token, email = await _get_access_token()
    except httpx.ConnectError:
        logger.warning(
            "GCE metadata server unreachable (local dev?) — skipping HTML upload"
        )
        return None
    except Exception:
        logger.exception("Failed to get GCS access token")
        return None

    # Upload the HTML object
    try:
        upload_url = _GCS_UPLOAD_URL.format(bucket=quote(bucket, safe=""))
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                upload_url,
                params={
                    "uploadType": "media",
                    "name": object_name,
                },
                content=html_content.encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "text/html; charset=utf-8",
                },
            )
            if resp.status_code not in (200, 201):
                logger.error(
                    "GCS upload failed: %d %s", resp.status_code, resp.text[:200],
                )
                return None
            logger.info("Uploaded %s to gs://%s", object_name, bucket)
    except Exception:
        logger.exception("GCS upload error")
        return None

    # Generate signed URL
    try:
        now = datetime.utcnow()
        credential_scope = f"{now.strftime('%Y%m%d')}/auto/storage/goog4_request"
        credential = f"{email}/{credential_scope}"
        timestamp = now.strftime("%Y%m%dT%H%M%SZ")

        canonical_uri = f"/{bucket}/{quote(object_name, safe='')}"
        canonical_query = (
            f"X-Goog-Algorithm=GOOG4-RSA-SHA256"
            f"&X-Goog-Credential={quote(credential, safe='')}"
            f"&X-Goog-Date={timestamp}"
            f"&X-Goog-Expires={_SIGNED_URL_EXPIRY_SECONDS}"
            f"&X-Goog-SignedHeaders=host"
        )
        canonical_headers = "host:storage.googleapis.com\n"
        canonical_request = (
            f"GET\n{canonical_uri}\n{canonical_query}\n"
            f"{canonical_headers}\nhost\nUNSIGNED-PAYLOAD"
        )

        string_to_sign = (
            f"GOOG4-RSA-SHA256\n{timestamp}\n{credential_scope}\n"
            + hashlib.sha256(canonical_request.encode()).hexdigest()
        )

        signed_bytes = await _sign_blob(
            access_token, email, string_to_sign.encode(),
        )
        signature = signed_bytes.hex()

        signed_url = (
            f"https://storage.googleapis.com{canonical_uri}"
            f"?{canonical_query}&X-Goog-Signature={signature}"
        )

        logger.info("Generated 12h signed URL for %s", object_name)
        return signed_url

    except Exception:
        logger.exception("Failed to generate signed URL")
        return None
