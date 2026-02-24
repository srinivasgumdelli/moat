#!/usr/bin/env python3
"""One-time Telegram Bot setup helper.

Steps:
1. Create a bot via @BotFather on Telegram
2. Get your chat ID by messaging the bot and running this script
3. Add the bot token and chat ID to your .env file
"""

from __future__ import annotations

import asyncio
import sys


async def get_chat_id(token: str) -> None:
    """Fetch recent updates to find your chat ID."""
    from telegram import Bot

    bot = Bot(token=token)
    updates = await bot.get_updates()

    if not updates:
        print("\nNo messages found. Please:")
        print("1. Open Telegram and find your bot")
        print("2. Send it any message (e.g., 'hello')")
        print("3. Run this script again")
        return

    print("\nRecent chats:")
    seen = set()
    for update in updates:
        chat = update.effective_chat
        if chat and chat.id not in seen:
            seen.add(chat.id)
            name = chat.full_name or chat.title or "Unknown"
            print(f"  Chat ID: {chat.id}  Name: {name}  Type: {chat.type}")

    print("\nAdd TELEGRAM_CHAT_ID to your .env file with the desired chat ID above.")


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/setup_telegram.py <BOT_TOKEN>")
        print("\nGet a bot token from @BotFather on Telegram.")
        sys.exit(1)

    token = sys.argv[1]
    asyncio.run(get_chat_id(token))


if __name__ == "__main__":
    main()
