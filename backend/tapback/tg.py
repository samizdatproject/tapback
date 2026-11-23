"""Telethon user client: the only module that talks to Telegram.

Message text is kept in memory only and never logged.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.custom.dialog import Dialog
from telethon.tl.functions.account import UpdateNotifySettingsRequest
from telethon.tl.functions.messages import GetPeerDialogsRequest, SendReactionRequest
from telethon.tl.types import InputNotifyPeer, InputPeerNotifySettings, ReactionEmoji

from . import config, session_store
from .cards import build_card

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


def describe_media(msg) -> str:
    for attr, label in (("photo", "photo"), ("video", "video"), ("voice", "voice message"), ("sticker", "sticker"),
                        ("gif", "GIF"), ("document", "file"), ("poll", "poll"), ("geo", "location")):
        if getattr(msg, attr, None):
            return f"[{label}]"
    return "[message]"


def sender_name(msg) -> str:
    s = msg.sender
    if s is None:
        return "Channel" if msg.post else "Someone"
    if getattr(s, "first_name", None) is not None or getattr(s, "last_name", None) is not None:
        return " ".join(p for p in (s.first_name, s.last_name) if p) or "Someone"
    return getattr(s, "title", None) or "Someone"


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
        self.client.add_event_handler(self._changed, events.MessageRead(inbox=True))
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

    async def card(self, chat_id: str) -> dict:
        """The newest unread messages of one chat; showing them marks the chat read up to the newest one."""
        entity = await self.client.get_entity(int(chat_id))
        peer = await self.client.get_input_entity(entity)
        dialogs = await self.client(GetPeerDialogsRequest(peers=[peer]))
        unread = int(dialogs.dialogs[0].unread_count) if dialogs.dialogs else 0
        history = await self.client.get_messages(entity, limit=3)
        recent = [
            {
                "id": msg.id,
                "sender": "You" if msg.out else sender_name(msg),
                "time": msg.date.astimezone().strftime("%H:%M"),
                "text": msg.message or describe_media(msg),
                "mine": bool(msg.out),
                "mentions_me": bool(msg.mentioned),
            }
            for msg in history
        ]
        title = getattr(entity, "title", None) or " ".join(
            p for p in (getattr(entity, "first_name", None), getattr(entity, "last_name", None)) if p
        )
        kind = "user" if hasattr(entity, "first_name") else ("channel" if getattr(entity, "broadcast", False) else "group")
        card = build_card({"id": chat_id, "title": title or "(no name)", "kind": kind}, recent, unread)
        if history:
            # Telegram API terms 1.4: no "ghost mode". What is shown is marked read.
            await self.client.send_read_acknowledge(entity, max_id=max(m.id for m in history[: max(1, min(3, unread))]))
        return card

    async def send(self, chat_id: str, reply_to: int | None, text: str | None, reaction: str | None) -> None:
        entity = await self.client.get_entity(int(chat_id))
        if reaction:
            if reply_to is None:
                raise ValueError("a reaction needs a message")
            await self.client(SendReactionRequest(peer=entity, msg_id=reply_to, reaction=[ReactionEmoji(emoticon=reaction)]))
        else:
            await self.client.send_message(entity, text, reply_to=reply_to)

    async def mute(self, chat_id: str, minutes: int) -> None:
        entity = await self.client.get_input_entity(int(chat_id))
        until = datetime.now(timezone.utc) + timedelta(minutes=minutes)
        await self.client(UpdateNotifySettingsRequest(
            peer=InputNotifyPeer(entity), settings=InputPeerNotifySettings(mute_until=until)))
