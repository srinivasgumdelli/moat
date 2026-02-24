"""Tests for Telegram delivery."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from intel.deliver.telegram import TelegramDelivery


@pytest.fixture
def telegram_config():
    return {
        "deliver": {
            "telegram": {
                "enabled": True,
                "bot_token": "fake-token",
                "chat_id": "12345",
                "max_message_length": 4096,
            }
        }
    }


def test_split_message_short():
    """Short messages are not split."""
    chunks = TelegramDelivery._split_message("hello", 4096)
    assert chunks == ["hello"]


def test_split_message_long():
    """Long messages are split at line boundaries."""
    lines = [f"Line {i}" for i in range(200)]
    text = "\n".join(lines)
    chunks = TelegramDelivery._split_message(text, 100)
    assert len(chunks) > 1
    assert all(len(c) <= 100 for c in chunks)
    # All content preserved
    rejoined = "\n".join(chunks)
    assert rejoined == text


@pytest.mark.asyncio
@patch("intel.deliver.telegram.Bot")
async def test_send_calls_bot(mock_bot_cls, telegram_config):
    """Send calls the Telegram Bot API."""
    mock_bot = AsyncMock()
    mock_bot_cls.return_value = mock_bot

    delivery = TelegramDelivery(telegram_config)
    result = await delivery.send("Test message")

    assert result is True
    mock_bot.send_message.assert_called_once_with(
        chat_id="12345", text="Test message",
    )


@pytest.mark.asyncio
@patch("intel.deliver.telegram.Bot")
async def test_send_test(mock_bot_cls, telegram_config):
    """Test message sends successfully."""
    mock_bot = AsyncMock()
    mock_bot_cls.return_value = mock_bot

    delivery = TelegramDelivery(telegram_config)
    result = await delivery.send_test()

    assert result is True
    mock_bot.send_message.assert_called_once()


@pytest.mark.asyncio
@patch("intel.deliver.telegram.Bot")
async def test_send_failure_returns_false(
    mock_bot_cls, telegram_config,
):
    """Send returns False on API failure."""
    mock_bot = AsyncMock()
    mock_bot.send_message.side_effect = Exception("API error")
    mock_bot_cls.return_value = mock_bot

    delivery = TelegramDelivery(telegram_config)
    result = await delivery.send("Test message")

    assert result is False


def test_missing_config_raises():
    """Missing bot_token raises ValueError."""
    config = {"deliver": {"telegram": {"bot_token": "", "chat_id": ""}}}
    delivery = TelegramDelivery(config)
    with pytest.raises(ValueError, match="bot_token"):
        delivery._get_bot()
