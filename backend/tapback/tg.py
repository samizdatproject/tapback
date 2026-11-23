"""Telethon user client: the only module that talks to Telegram.

Message text is kept in memory only and never logged.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.custom.dialog import Dialog
from telethon.tl.functions.account import UpdateNotifySettingsRequest
from telethon.tl.functions.messages import (
    GetPeerDialogsRequest,
    GetSponsoredMessagesRequest,
    SendReactionRequest,
    ViewSponsoredMessageRequest,
)
from telethon.tl.types import InputNotifyPeer, InputPeerNotifySettings, ReactionEmoji
from telethon.tl.types.messages import SponsoredMessages

from . import config, rules, session_store
from .cards import build_card
from .digest import strip_emoji, top_posts

SPONSORED_CACHE_S = 300  # getSponsoredMessages: "The result must be cached for 5 minutes"

log = logging.getLogger("tapback.tg")


def chat_kind(dialog: Dialog) -> str:
    if dialog.is_user:
        return "user"
    if dialog.is_channel and not dialog.is_group:
        return "channel"
    return "group"


def chat_flag(dialog: Dialog) -> str:
    """'!' when an unread message mentions me or the newest unread one matches an urgent keyword."""
    unread = int(dialog.unread_count or 0)
    if not unread:
        return ""
    if int(getattr(dialog.dialog, "unread_mentions_count", 0) or 0) > 0:
        return "!"
    last = dialog.message
    if last is not None and not last.out and rules.is_urgent(last.message or ""):
        return "!"
    return ""


def chat_row(dialog: Dialog, picked: set[str]) -> dict:
    cid = str(dialog.id)
    return {
        "id": cid,
        "title": dialog.title or dialog.name or "(no name)",
        "kind": chat_kind(dialog),
        "unread": int(dialog.unread_count or 0),
        "flag": chat_flag(dialog),
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
            # Sleep through short flood waits only; a long one fails fast so the glasses can say so.
            flood_sleep_threshold=15,
        )
        self._on_change: Callable[[], Awaitable[None]] | None = None
        self._change_task: asyncio.Task | None = None
        self._dirty = False
        self._sponsored: dict[str, tuple[float, dict | None]] = {}
        self._sponsored_ids: set[bytes] = set()

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
        # Coalesce bursts of updates into one refresh about a second later. Updates that arrive
        # while a refresh is running mark it dirty, and the refresh runs again afterwards.
        if self._on_change is None:
            return
        self._dirty = True
        if self._change_task and not self._change_task.done():
            return

        async def refresh() -> None:
            while self._dirty:
                self._dirty = False
                await asyncio.sleep(1.0)
                try:
                    await self._on_change()
                except Exception:  # never let a refresh error kill the update loop
                    log.exception("inbox refresh failed")

        self._change_task = asyncio.create_task(refresh())

    async def chats(self, picked: list[str]) -> list[dict]:
        """Main chat list only: archived chats are never offered or shown."""
        picked_set = set(picked)
        dialogs = await self.client.get_dialogs(limit=self._dialog_limit, archived=False)
        return [chat_row(d, picked_set) for d in dialogs]

    async def card(self, chat_id: str) -> dict:
        """The newest messages of one chat (up to 3 unread). Marked read later, when shown (card_shown)."""
        entity = await self.client.get_entity(int(chat_id))
        peer = await self.client.get_input_entity(entity)
        dialogs, history = await asyncio.gather(  # two round trips in parallel
            self.client(GetPeerDialogsRequest(peers=[peer])),
            self.client.get_messages(entity, limit=3),
        )
        unread = int(dialogs.dialogs[0].unread_count) if dialogs.dialogs else 0
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
        # Marked read only when the glasses report the card as displayed (card_shown).
        card["readMaxId"] = max((m["id"] for m in card["msgs"]), default=None)
        return card

    async def chat_kind(self, chat_id: str) -> str:
        entity = await self.client.get_entity(int(chat_id))
        if hasattr(entity, "first_name"):
            return "user"
        return "channel" if getattr(entity, "broadcast", False) else "group"

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

    async def _dialog(self, entity):
        peer = await self.client.get_input_entity(entity)
        res = await self.client(GetPeerDialogsRequest(peers=[peer]))
        return res.dialogs[0] if res.dialogs else None

    async def sponsored(self, chat_id: str) -> dict | None:
        """The channel's sponsored message, cached for 5 minutes as Telegram requires."""
        cached = self._sponsored.get(chat_id)
        if cached and time.monotonic() - cached[0] < SPONSORED_CACHE_S:
            return cached[1]
        entity = await self.client.get_entity(int(chat_id))
        res = await self.client(GetSponsoredMessagesRequest(peer=entity))
        ad = None
        if isinstance(res, SponsoredMessages) and res.messages:
            m = res.messages[0]
            self._sponsored_ids.add(m.random_id)
            ad = {
                "randomId": base64.urlsafe_b64encode(m.random_id).decode(),
                "label": "Recommended" if m.recommended else "Sponsored",
                # Verbatim, minus emoji the G2 font draws as empty boxes.
                "title": " ".join(strip_emoji(m.title or "").split()),
                "text": " ".join(strip_emoji(m.message or "").split()),
                "button": " ".join(strip_emoji(m.button_text or "").split()),
                "sponsorInfo": m.sponsor_info,
                "additionalInfo": m.additional_info,
            }
        self._sponsored[chat_id] = (time.monotonic(), ad)
        return ad

    async def view_sponsored(self, random_id_b64: str) -> bool:
        """Reports one view of a sponsored message that TapBack actually displayed."""
        try:
            rid = base64.urlsafe_b64decode(random_id_b64.encode())
        except ValueError:
            return False
        if rid not in self._sponsored_ids:
            return False
        self._sponsored_ids.discard(rid)  # one view per fetched ad
        await self.client(ViewSponsoredMessageRequest(random_id=rid))
        return True

    async def digest(self, channel_ids: list[str]) -> list[dict]:
        """For each channel: its new posts ranked by engagement (top 3, first line verbatim) and its ad."""
        seen: set[str] = set()
        out = []
        now = datetime.now(timezone.utc)
        for cid in channel_ids:
            entity = await self.client.get_entity(int(cid))
            dialog = await self._dialog(entity)
            unread = int(dialog.unread_count) if dialog else 0
            if unread:
                posts = await self.client.get_messages(entity, min_id=dialog.read_inbox_max_id, limit=100)
            else:  # nothing new: show the best of the last 24 hours, clearly labelled as not new
                posts = [m for m in await self.client.get_messages(entity, limit=30)
                         if (now - m.date).total_seconds() < 86400]
            rows = [
                {
                    "id": m.id,
                    "text": m.message or "",
                    "views": m.views or 0,
                    "reactions": sum(r.count for r in m.reactions.results) if m.reactions else 0,
                    "forwards": m.forwards or 0,
                    "pinned": bool(m.pinned),
                    "age_h": (now - m.date).total_seconds() / 3600,
                }
                for m in posts
            ]
            out.append({
                "id": cid,
                "title": getattr(entity, "title", None) or "(channel)",
                "newCount": unread,
                "top": top_posts(rows, seen),
                "recent": not unread,
                "maxId": max((m.id for m in posts), default=None) if unread else None,
                "sponsored": await self.sponsored(cid),
            })
        return out

    async def mark_read(self, chat_id: str, max_id: int) -> None:
        entity = await self.client.get_entity(int(chat_id))
        await self.client.send_read_acknowledge(entity, max_id=max_id)

    async def log_out(self) -> bool:
        """Ends this Telegram session on Telegram's side (auth.logOut) and always wipes it locally.

        Returns False if Telegram didn't confirm the logout.
        """
        try:
            return bool(await self.client.log_out())
        finally:
            session_store.wipe(self._cfg.session_file, self._cfg.key_file)
            if self.client.is_connected():
                await self.client.disconnect()
