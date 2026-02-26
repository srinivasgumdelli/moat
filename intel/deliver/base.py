"""Abstract base class for delivery channels."""

from __future__ import annotations

from abc import ABC, abstractmethod


class BaseDelivery(ABC):
    """Base class for message delivery channels."""

    def __init__(self, config: dict):
        self.config = config

    @abstractmethod
    async def send(
        self,
        message: str,
        attachment: bytes | None = None,
        attachment_name: str | None = None,
    ) -> bool:
        """Send a message, optionally with a file attachment. Returns True on success."""
        ...

    @abstractmethod
    async def send_test(self) -> bool:
        """Send a test message to verify configuration."""
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Channel name."""
        ...
