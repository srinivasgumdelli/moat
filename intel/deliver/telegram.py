"""Telegram delivery channel."""

from __future__ import annotations

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

    async def send(self, message: str) -> bool:
        """Send a message, splitting if it exceeds Telegram's limit."""
        bot, chat_id = self._get_bot()
        max_len = self.config.get("deliver", {}).get("telegram", {}).get(
            "max_message_length", 4096
        )

        chunks = self._split_message(message, max_len)
        try:
            for chunk in chunks:
                await bot.send_message(chat_id=chat_id, text=chunk)
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
                text="Intel Summarizer — test message. Configuration OK.",
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
