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

from telethon import TelegramClient, events, utils
from telethon.sessions import StringSession
from telethon.tl.custom.dialog import Dialog
from telethon.tl.functions.account import UpdateNotifySettingsRequest
from telethon.tl.functions.messages import (
    GetPeerDialogsRequest,
    GetSponsoredMessagesRequest,
    MarkDialogUnreadRequest,
    SendReactionRequest,
    TranslateTextRequest,
    ViewSponsoredMessageRequest,
)
from telethon.tl.types import (
    Channel,
    Chat,
    InputDialogPeer,
    InputNotifyPeer,
    InputPeerNotifySettings,
    ReactionEmoji,
    UpdateDialogUnreadMark,
    User,
)
from telethon.tl.types.messages import SponsoredMessages

from . import config, rules, session_store
from .cards import build_card, cut
from .digest import strip_emoji, top_posts
from .media import media_label, message_text
from .settings import Settings, is_vip, keyword_pattern

SPONSORED_CACHE_S = 300  # getSponsoredMessages: "The result must be cached for 5 minutes"

log = logging.getLogger("tapback.tg")


def chat_kind(dialog: Dialog) -> str:
    if dialog.is_user:
        return "user"
    if dialog.is_channel and not dialog.is_group:
        return "channel"
    return "group"


def chat_flag(dialog: Dialog, prefs: Settings | None = None) -> str:
    """'!' for a mention of me or an urgent keyword in the newest unread message; '★' for a VIP sender."""
    prefs = prefs or Settings()
    unread = int(dialog.unread_count or 0)
    if not unread:
        return ""
    if int(getattr(dialog.dialog, "unread_mentions_count", 0) or 0) > 0:
        return "!"
    last = dialog.message
    if last is None or last.out:
        return ""
    if rules.is_urgent(last.message or "", keyword_pattern(prefs.keywords)):
        return "!"
    sender = last.sender
    names = [getattr(sender, "username", None), sender_name(last)] if sender is not None else []
    if dialog.is_user:
        names += [dialog.name, getattr(dialog.entity, "username", None)]
    return "★" if is_vip(prefs, *names) else ""


def breaks_through(entity, raw, prefs: Settings | None) -> bool:
    """An unpicked chat that may reach the glasses (opt-in): it has unread messages and is either
    a private chat with a VIP or a group that mentions me. Never a channel or an archived chat.

    `raw` is the Telegram dialog (types.Dialog) with the counters and the folder.
    """
    if prefs is None or not prefs.breakthrough or raw is None or getattr(raw, "folder_id", None) == 1:
        return False
    unread = int(getattr(raw, "unread_count", 0) or 0) > 0
    if isinstance(entity, User):
        # A VIP chat the user kept for later (unread_mark) stays on the glasses until it's opened again.
        if not (unread or getattr(raw, "unread_mark", False)):
            return False
        return not entity.is_self and is_vip(prefs, utils.get_display_name(entity), entity.username)
    if not unread:
        return False
    if isinstance(entity, Chat) or (isinstance(entity, Channel) and entity.megagroup):
        return int(getattr(raw, "unread_mentions_count", 0) or 0) > 0
    return False


def chat_row(dialog: Dialog, picked: set[str], prefs: Settings | None = None) -> dict:
    cid = str(dialog.id)
    return {
        "id": cid,
        "title": dialog.title or dialog.name or "(no name)",
        "kind": chat_kind(dialog),
        "unread": int(dialog.unread_count or 0),
        "flag": chat_flag(dialog, prefs),
        "picked": cid in picked,
        # Marked unread in Telegram ("Later" on the glasses, or "Mark as unread" on the phone).
        "later": bool(getattr(dialog.dialog, "unread_mark", False)),
        "breakthrough": cid not in picked and breaks_through(dialog.entity, dialog.dialog, prefs),
    }


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
        self.client.add_event_handler(self._changed, events.Raw(UpdateDialogUnreadMark))  # marked unread elsewhere
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

    async def chats(self, picked: list[str], prefs: Settings | None = None) -> list[dict]:
        """Main chat list only: archived chats are never offered or shown."""
        picked_set = set(picked)
        dialogs = await self.client.get_dialogs(limit=self._dialog_limit, archived=False)
        return [chat_row(d, picked_set, prefs) for d in dialogs]

    async def card(self, chat_id: str) -> dict:
        """The newest messages of one chat (up to 3 unread). Marked read later, when shown (card_shown)."""
        entity = await self.client.get_entity(int(chat_id))
        peer = await self.client.get_input_entity(entity)
        dialogs, history = await asyncio.gather(  # two round trips in parallel
            self.client(GetPeerDialogsRequest(peers=[peer])),
            self.client.get_messages(entity, limit=3),
        )
        unread = int(dialogs.dialogs[0].unread_count) if dialogs.dialogs else 0
        later = bool(dialogs.dialogs[0].unread_mark) if dialogs.dialogs else False
        recent = [
            {
                "id": msg.id,
                "sender": "You" if msg.out else sender_name(msg),
                "time": msg.date.astimezone().strftime("%H:%M"),
                "text": message_text(msg),
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
        card["later"] = later  # for the server only: card_shown clears the mark
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

    async def breakthrough(self, chat_id: str, prefs: Settings) -> bool:
        """Re-checks on Telegram whether an unpicked chat breaks through right now."""
        try:
            entity = await self.client.get_entity(int(chat_id))
        except ValueError:  # not a chat this account knows
            return False
        return breaks_through(entity, await self._dialog(entity), prefs)

    async def mark_unread(self, chat_id: str, unread: bool) -> None:
        """Telegram's own "Mark as unread" (messages.markDialogUnread): the state lives in Telegram."""
        entity = await self.client.get_input_entity(int(chat_id))
        await self.client(MarkDialogUnreadRequest(peer=InputDialogPeer(entity), unread=unread))

    async def translate(self, chat_id: str, ids: list[int], to_lang: str) -> dict[int, str]:
        """Telegram's own translation (messages.translateText) of a card's messages, by id.

        Telegram reads and translates the messages on its own servers, so no text goes to any other
        service. Media-only messages are skipped; a caption is translated and keeps its media label.
        """
        peer = await self.client.get_input_entity(int(chat_id))
        msgs = [m for m in await self.client.get_messages(peer, ids=ids) if m is not None and (m.message or "").strip()]
        if not msgs:
            return {}
        res = await self.client(TranslateTextRequest(to_lang=to_lang, peer=peer, id=[m.id for m in msgs]))
        out = {}
        for msg, done in zip(msgs, res.result):
            text = (getattr(done, "text", "") or "").strip()
            if text:
                out[msg.id] = cut(" ".join(p for p in (media_label(msg), text) if p))
        return out

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

    async def mark_read(self, chat_id: str, max_id: int, clear_mentions: bool = False) -> None:
        """clear_mentions: for a group that came through by an @mention, the mention was just shown,
        so clear Telegram's mention counter too; otherwise every later message would break through."""
        entity = await self.client.get_entity(int(chat_id))
        await self.client.send_read_acknowledge(entity, max_id=max_id, clear_mentions=clear_mentions)

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
