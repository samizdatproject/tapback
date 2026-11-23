"""Telethon user client: the only module that talks to Telegram.

Message text is kept in memory only and never logged.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.custom.dialog import Dialog

from . import config, session_store

log = logging.getLogger("tapback.tg")


def chat_kind(dialog: Dialog) -> str:
    if dialog.is_user:
        return "user"
    if dialog.is_channel and not dialog.is_group:
        return "channel"
    return "group"


def chat_row(dialog: Dialog, picked: set[str]) -> dict:
    cid = str(dialog.id)
    return {
        "id": cid,
        "title": dialog.title or dialog.name or "(no name)",
        "kind": chat_kind(dialog),
        "unread": int(dialog.unread_count or 0),
        "picked": cid in picked,
    }


class Telegram:
    def __init__(self, cfg: config.Config, dialog_limit: int = 200):
        self._cfg = cfg
        self._dialog_limit = dialog_limit
        self.client = TelegramClient(
            StringSession(session_store.load(cfg.session_file, cfg.key_file)),
            cfg.api_id,
            cfg.api_hash,
            flood_sleep_threshold=60,
        )
        self._on_change: Callable[[], Awaitable[None]] | None = None
        self._change_task: asyncio.Task | None = None

    async def start(self) -> None:
        await self.client.connect()
        if not await self.client.is_user_authorized():
            raise SystemExit("The saved session is no longer valid. Run: python -m tapback login")
        self.client.add_event_handler(self._changed, events.NewMessage())
        self.client.add_event_handler(self._changed, events.MessageRead())
        await self.client.get_dialogs(limit=self._dialog_limit, archived=False)  # fills the entity cache

    async def stop(self) -> None:
        await self.client.disconnect()

    def on_change(self, callback: Callable[[], Awaitable[None]]) -> None:
        self._on_change = callback

    async def _changed(self, _event) -> None:
        # Coalesce bursts of updates into one refresh about a second later.
        if self._on_change is None or (self._change_task and not self._change_task.done()):
            return

        async def later() -> None:
            await asyncio.sleep(1.0)
            try:
                await self._on_change()
            except Exception:  # never let a refresh error kill the update loop
                log.exception("inbox refresh failed")

        self._change_task = asyncio.create_task(later())

    async def chats(self, picked: list[str]) -> list[dict]:
        """Main chat list only: archived chats are never offered or shown."""
        picked_set = set(picked)
        dialogs = await self.client.get_dialogs(limit=self._dialog_limit, archived=False)
        return [chat_row(d, picked_set) for d in dialogs]
