"""Telegram delivery channel."""

from __future__ import annotations

import io
import logging

from telegram import Bot

from intel.deliver import register_channel
from intel.deliver.base import BaseDelivery

logger = logging.getLogger(__name__)


@register_channel("telegram")
class TelegramDelivery(BaseDelivery):
    """Send digests via Telegram Bot."""

    @property
    def name(self) -> str:
        return "telegram"

    def _get_bot(self) -> tuple[Bot, str]:
        cfg = self.config.get("deliver", {}).get("telegram", {})
        token = cfg.get("bot_token", "")
        chat_id = cfg.get("chat_id", "")
        if not token or not chat_id:
            raise ValueError("Telegram bot_token and chat_id must be configured")
        return Bot(token=token), str(chat_id)

    async def send(
        self,
        message: str,
        attachment: bytes | None = None,
        attachment_name: str | None = None,
    ) -> bool:
        """Send a message, optionally as a document attachment."""
        bot, chat_id = self._get_bot()

        # Document mode: send PDF (or other file) with caption
        if attachment is not None:
            try:
                doc = io.BytesIO(attachment)
                doc.name = attachment_name or "document.pdf"
                await bot.send_document(
                    chat_id=chat_id,
                    document=doc,
                    caption=message[:1024],
                )
                logger.info("Sent document '%s' to Telegram", doc.name)
                return True
            except Exception:
                logger.exception("Failed to send Telegram document")
                return False

        # Text mode: split long messages
        max_len = self.config.get("deliver", {}).get("telegram", {}).get(
            "max_message_length", 4096
        )
        chunks = self._split_message(message, max_len)
        try:
            for chunk in chunks:
                await bot.send_message(
                    chat_id=chat_id,
                    text=chunk,
                    parse_mode="HTML",
                    disable_web_page_preview=True,
                )
            logger.info("Sent %d message(s) to Telegram", len(chunks))
            return True
        except Exception:
            logger.exception("Failed to send Telegram message")
            return False

    async def send_test(self) -> bool:
        """Send a test message to verify Telegram configuration."""
        bot, chat_id = self._get_bot()
        try:
            await bot.send_message(
                chat_id=chat_id,
                text="<b>Intel Summarizer</b> — test message. Configuration OK.",
                parse_mode="HTML",
            )
            logger.info("Telegram test message sent successfully")
            return True
        except Exception:
            logger.exception("Telegram test failed")
            return False

    @staticmethod
    def _split_message(text: str, max_len: int = 4096) -> list[str]:
        """Split a long message into chunks at line boundaries."""
        if len(text) <= max_len:
            return [text]

        chunks = []
        current = ""
        for line in text.split("\n"):
            if len(current) + len(line) + 1 > max_len:
                if current:
                    chunks.append(current)
                current = line
            else:
                current = f"{current}\n{line}" if current else line

        if current:
            chunks.append(current)

        return chunks
