"""One-time login in your own terminal: phone -> code -> (2FA password).

The code and password are read without echo and are never printed or logged.
The resulting session is saved encrypted (see session_store).
"""

from __future__ import annotations

import asyncio
from getpass import getpass

from telethon import TelegramClient
from telethon.sessions import StringSession

from . import config, session_store


async def _login(cfg: config.Config) -> None:
    client = TelegramClient(StringSession(), cfg.api_id, cfg.api_hash)
    await client.start(
        phone=lambda: input("Phone number (international format, e.g. +44...): ").strip(),
        code_callback=lambda: getpass("Login code from Telegram (hidden): ").strip(),
        password=lambda: getpass("Two-step verification password (hidden): "),
    )
    me = await client.get_me()
    session_store.save(cfg.session_file, cfg.key_file, client.session.save())
    await client.disconnect()
    print(f"Logged in as {me.first_name or 'user'}. Encrypted session saved to {cfg.session_file}")


def main() -> None:
    cfg = config.load()
    print("TapBack: unofficial Telegram client for Even G2. Uses the Telegram API.")
    asyncio.run(_login(cfg))
