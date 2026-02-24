"""Delivery channel registry."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intel.deliver.base import BaseDelivery

CHANNELS: dict[str, type[BaseDelivery]] = {}


def register_channel(name: str):
    """Decorator to register a delivery channel."""

    def decorator(cls):
        CHANNELS[name] = cls
        return cls

    return decorator


from intel.deliver.telegram import TelegramDelivery  # noqa: E402, F401
