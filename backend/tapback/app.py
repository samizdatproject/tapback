"""HTTP + WebSocket API for the glasses plugin.

The plugin pairs once with a 6-digit code printed by the backend, then sends its device
token as a Bearer header (HTTP) or in the first WebSocket message.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from datetime import datetime
from typing import Awaitable, Callable, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import rules, stt
from .inbox import build_inbox
from .settings import Settings, SettingsError, in_quiet_hours
from .store import Store

Transcriber = Callable[[bytes], Awaitable[str]]

log = logging.getLogger("tapback.app")

TAGLINE = "TapBack: unofficial Telegram client for Even G2. Uses the Telegram API."
HELLO_TIMEOUT_S = 10
SENDS_PER_MINUTE = 10
MAX_TEXT = 1000
REACTIONS = {"👍"}
MUTE_MINUTES = {60, 480}
SNOOZE_MINUTES = {30, 60}
RESULT_TTL_S = 600
MAX_PICKED = 50
BREAKTHROUGH_GRANT_S = 900  # a breakthrough chat stays reachable this long after the server checked it


class Telegram(Protocol):
    async def chats(self, picked: list[str], prefs: Settings | None = None) -> list[dict]: ...
    async def card(self, chat_id: str) -> dict: ...
    async def send(self, chat_id: str, reply_to: int | None, text: str | None, reaction: str | None) -> None: ...
    async def mute(self, chat_id: str, minutes: int) -> None: ...
    async def mark_unread(self, chat_id: str, unread: bool) -> None: ...
    async def breakthrough(self, chat_id: str, prefs: Settings) -> bool: ...
    async def digest(self, channel_ids: list[str]) -> list[dict]: ...
    async def mark_read(self, chat_id: str, max_id: int, clear_mentions: bool = False) -> None: ...
    async def view_sponsored(self, random_id_b64: str) -> bool: ...
    async def log_out(self) -> bool: ...
    async def chat_kind(self, chat_id: str) -> str: ...


class PairBody(BaseModel):
    code: str


class PickedBody(BaseModel):
    chatIds: list[str]


class Hub:
    """State shared by every glasses connection: sockets, the send limit and send results."""

    def __init__(self, tg: Telegram, store: Store, transcribe: Transcriber):
        self.tg, self.store, self.transcribe = tg, store, transcribe
        self.sockets: set[WebSocket] = set()
        self.sends: deque[float] = deque()  # across all devices and reconnects
        self.results: dict[str, tuple[float, asyncio.Future]] = {}
        self.granted: dict[str, float] = {}  # breakthrough chat id -> when the server last confirmed it

    async def inbox(self) -> dict:
        hidden = self.store.hidden()
        picked = self.store.picked()
        visible = [c for c in picked if c not in hidden]
        prefs = self.store.settings()
        # All picks go to tg.chats, so a muted pick never comes back as a breakthrough chat.
        inbox = build_inbox(await self.tg.chats(picked, prefs), visible, hidden)
        # Quiet hours: the glasses show counts only and don't move on to the next card by themselves.
        inbox["quiet"] = {"active": in_quiet_hours(prefs, datetime.now().time()), "until": prefs.quiet_end}
        return inbox

    async def broadcast(self) -> None:
        if not self.sockets:
            return
        msg = json.dumps(await self.inbox())
        for ws in list(self.sockets):
            try:
                await ws.send_text(msg)
            except Exception:
                self.sockets.discard(ws)

    async def allowed(self, chat_id) -> str | None:
        """A picked chat, or an unpicked one that breaks through, as checked here on Telegram.

        Once confirmed, a breakthrough chat stays allowed for a while: showing its card marks it
        read, and it would otherwise stop qualifying before the reply goes out.
        """
        cid = str(chat_id or "")
        if cid in self.store.picked():
            return cid
        prefs = self.store.settings()
        if not prefs.breakthrough or not cid.lstrip("-").isdigit():
            return None
        now = time.monotonic()
        if now - self.granted.get(cid, -BREAKTHROUGH_GRANT_S) < BREAKTHROUGH_GRANT_S:
            return cid
        if not await self.tg.breakthrough(cid, prefs):
            return None
        self.granted[cid] = now
        return cid

    def rate_ok(self) -> bool:
        now = time.monotonic()
        while self.sends and now - self.sends[0] > 60:
            self.sends.popleft()
        if len(self.sends) >= SENDS_PER_MINUTE:
            return False
        self.sends.append(now)
        return True

    def prune_results(self) -> None:
        cutoff = time.monotonic() - RESULT_TTL_S
        for key in [k for k, (t, _) in self.results.items() if t < cutoff]:
            del self.results[key]


class Session:
    """One glasses connection: routes its messages."""

    def __init__(self, hub: Hub, ws: WebSocket):
        self.hub, self.ws = hub, ws
        self.recorder = stt.Recorder()
        self.dictation_id = ""
        self.tasks: set[asyncio.Task] = set()
        self.current: dict = {}
        self.unmark: set[str] = set()  # chats whose card was opened while marked unread (Later)

    async def audio(self, chunk: bytes) -> None:
        self.recorder.add(chunk)

    async def reply(self, msg: dict) -> None:
        if msg.get("type") == "error":
            msg = {**self.current, **msg}  # which request failed, so the plugin can match it
        await self.ws.send_text(json.dumps(msg))

    def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        self.recorder.cancel()

    def _picked(self, chat_id) -> str | None:
        cid = str(chat_id or "")
        return cid if cid in self.hub.store.picked() else None

    async def _chat(self, chat_id) -> str | None:
        """A picked or breakthrough chat that isn't a broadcast channel (channels open in the digest)."""
        cid = await self.hub.allowed(chat_id)
        if cid is None:
            await self.reply({"type": "error", "code": "not_picked", "human": "That chat isn't picked"})
            return None
        if await self.hub.tg.chat_kind(cid) == "channel":
            await self.reply({"type": "error", "code": "channel", "human": "Channels open in the digest"})
            return None
        return cid

    async def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        self.current = {"for": kind, "chatId": str(msg.get("chatId") or msg.get("channelId") or "")}
        if kind == "open_inbox":
            await self.reply(await self.hub.inbox())
        elif kind == "open_chat":
            cid = await self._chat(msg.get("chatId"))
            if cid is not None:
                card = await self.hub.tg.card(cid)
                if card.pop("later", False):
                    self.unmark.add(cid)
                card["suggestions"] = rules.order_by_counts(card["suggestions"], self.hub.store.reply_counts(cid))
                await self.reply(card)
        elif kind == "card_shown":
            # Telegram API terms 1.4 (no ghost mode): what the glasses actually displayed is marked read,
            # and only that, so a card that never reached the screen leaves the chat unread.
            cid = await self.hub.allowed(msg.get("chatId"))
            later = cid is not None and cid in self.unmark
            if cid is None or not (later or isinstance(msg.get("maxId"), int)):
                return
            if isinstance(msg.get("maxId"), int):
                breakthrough = cid not in self.hub.store.picked()
                await self.hub.tg.mark_read(cid, msg["maxId"], clear_mentions=breakthrough)
                log.info("card shown: marked a chat read")
            if later:  # seen now, so it no longer waits for later
                self.unmark.discard(cid)
                await self.hub.tg.mark_unread(cid, False)
            await self.hub.broadcast()
        elif kind == "later":
            await self.later(msg)
        elif kind == "send":
            await self.send(msg)
        elif kind == "digest_open":
            hidden = self.hub.store.hidden()
            chats = await self.hub.tg.chats(self.hub.store.picked())
            kinds = {c["id"]: c["kind"] for c in chats}
            channels = [c for c in self.hub.store.picked() if kinds.get(c) == "channel" and c not in hidden]
            await self.reply({"type": "digest", "channels": await self.hub.tg.digest(channels)})
        elif kind == "digest_done":
            # Explicit "done" tap only: nothing in a channel is marked read silently.
            cid = self._picked(msg.get("channelId"))
            if cid is not None and isinstance(msg.get("maxId"), int):
                await self.hub.tg.mark_read(cid, msg["maxId"])
                log.info("digest done: marked a channel read")
                await self.hub.broadcast()
        elif kind == "audio_begin":
            self.dictation_id = str(msg.get("id") or "")[:64]
            self.recorder.begin()
        elif kind == "audio_cancel":
            self.recorder.cancel()
        elif kind == "audio_end":
            pcm = self.recorder.end()
            dictation = self.dictation_id
            if pcm is None:
                await self.reply({"type": "stt", "id": dictation, "text": "", "human": "Too short. Hold while you speak."})
                return
            # Transcribe off the receive loop so the next dictation's audio isn't stuck behind it.
            task = asyncio.create_task(self._transcribe(dictation, pcm))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        elif kind == "sponsored_viewed":
            await self.hub.tg.view_sponsored(str(msg.get("randomId") or ""))
        elif kind in ("mute", "snooze"):
            cid = await self.hub.allowed(msg.get("chatId"))
            minutes = int(msg.get("minutes") or 0) if str(msg.get("minutes") or "0").isdigit() else 0
            if cid is None or minutes not in (MUTE_MINUTES if kind == "mute" else SNOOZE_MINUTES):
                await self.reply({"type": "error", "code": "bad_request", "human": "Can't do that"})
                return
            if kind == "mute":
                await self.hub.tg.mute(cid, minutes)
            self.hub.store.hide(cid, minutes)
            await self.hub.broadcast()

    async def later(self, msg: dict) -> None:
        """Glanced but can't answer now: Telegram's own "Mark as unread", so the phone shows it too."""
        cid = await self._chat(msg.get("chatId"))
        if cid is None:
            return
        try:
            await self.hub.tg.mark_unread(cid, True)
        except Exception as exc:
            log.warning("mark unread failed: %s", type(exc).__name__)
            await self.reply({"type": "error", "code": "failed", "human": "Telegram didn't accept it. Try again."})
            return
        self.unmark.discard(cid)
        log.info("marked a chat unread for later")
        await self.reply({"type": "later", "chatId": cid, "ok": True})
        await self.hub.broadcast()

    async def _transcribe(self, dictation: str, pcm: bytes) -> None:
        try:
            text = await self.hub.transcribe(pcm)
        except Exception as exc:
            log.warning("speech-to-text failed: %s", type(exc).__name__)
            await self.reply({"type": "stt", "id": dictation, "text": "", "human": "Speech-to-text is offline"})
            return
        await self.reply({"type": "stt", "id": dictation, "text": text, "human": "" if text else "Didn't catch that"})

    async def send(self, msg: dict) -> None:
        client_id = str(msg.get("clientMsgId") or "")[:64]
        if not client_id:
            return
        hub = self.hub
        hub.prune_results()
        if client_id in hub.results:
            # A retry of a send already done or in flight: answer with its result, never send twice.
            result = await asyncio.shield(hub.results[client_id][1])
            await self.reply(result)
            return
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        hub.results[client_id] = (time.monotonic(), future)
        try:
            result = await self._send(msg, client_id)
        except BaseException:
            hub.results.pop(client_id, None)
            future.cancel()
            raise
        future.set_result(result)
        if not result["ok"]:
            hub.results.pop(client_id, None)  # nothing went out, so a retry may try again
        await self.reply(result)

    async def _send(self, msg: dict, client_id: str) -> dict:
        def fail(human: str) -> dict:
            return {"type": "sent", "clientMsgId": client_id, "ok": False, "human": human}

        cid = await self.hub.allowed(msg.get("chatId"))
        text = (msg.get("text") or "").strip()[:MAX_TEXT] or None
        reaction = msg.get("reaction") if msg.get("reaction") in REACTIONS else None
        reply_to = msg.get("replyTo") if isinstance(msg.get("replyTo"), int) else None
        if cid is None:
            return fail("Replies go only to chats you picked")
        if await self.hub.tg.chat_kind(cid) == "channel":
            return fail("You can't reply to a channel")
        if not (text or reaction):
            return fail("Nothing to send")
        if not self.hub.rate_ok():
            return fail("Slow down: 10 sends a minute")
        try:
            await self.hub.tg.send(cid, reply_to, text, reaction)
        except Exception as exc:
            log.warning("send failed: %s", type(exc).__name__)  # never log the text
            return fail("Telegram didn't accept it. Try again.")
        log.info("sent a %s", "reaction" if reaction else "reply")
        picked_reply = rules.REACT_THUMBS_UP if reaction else text
        if picked_reply in rules.VOCABULARY:  # learn the user's own choices, never free text
            self.hub.store.count_reply(cid, picked_reply)
        return {"type": "sent", "clientMsgId": client_id, "ok": True, "at": datetime.now().strftime("%H:%M")}


def create_app(tg: Telegram, store: Store, transcribe: Transcriber = stt.transcribe) -> FastAPI:
    app = FastAPI(title="TapBack backend", docs_url=None, redoc_url=None, openapi_url=None)
    # The plugin runs in a WebView whose origin differs per platform; access is
    # controlled by the device token, not by origin, and no cookies are used.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "PUT"],
                       allow_headers=["Authorization", "Content-Type"])
    hub = Hub(tg, store, transcribe)
    app.state.hub = hub
    app.state.shutdown = None  # set by serve.py so a logout also stops the server

    def device(authorization: str | None = Header(default=None)) -> None:
        token = authorization[7:] if authorization and authorization.startswith("Bearer ") else None
        if not store.is_device(token):
            raise HTTPException(status_code=401, detail="not paired")

    @app.get("/healthz")
    async def healthz() -> dict:
        return {"ok": True, "tagline": TAGLINE}

    @app.post("/pair")
    async def pair(body: PairBody) -> dict:
        token = store.redeem_pairing_code(body.code)
        if token is None:
            raise HTTPException(status_code=401, detail="wrong or expired code")
        log.info("device paired")
        return {"token": token}

    @app.get("/chats", dependencies=[Depends(device)])
    async def chats() -> dict:
        return {"chats": await tg.chats(store.picked(), store.settings())}

    @app.get("/settings", dependencies=[Depends(device)])
    async def get_settings() -> dict:
        return store.settings().to_json()

    @app.put("/settings", dependencies=[Depends(device)])
    async def put_settings(body: dict) -> dict:
        try:
            prefs = Settings.from_json(body)
        except SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        store.set_settings(prefs)
        await hub.broadcast()
        return {"ok": True, **prefs.to_json()}

    @app.put("/picked", dependencies=[Depends(device)])
    async def put_picked(body: PickedBody) -> dict:
        known = {c["id"] for c in await tg.chats([])}
        picked = [c for c in dict.fromkeys(body.chatIds) if c in known]
        if len(picked) > MAX_PICKED:
            raise HTTPException(status_code=400, detail=f"Pick at most {MAX_PICKED} chats")
        store.set_picked(picked)
        await hub.broadcast()
        return {"ok": True, "picked": len(picked)}

    @app.post("/logout", dependencies=[Depends(device)])
    async def logout() -> dict:
        """Log out & wipe: ends the Telegram session, deletes it, forgets every paired device."""
        try:
            telegram_ok = await tg.log_out()
        except Exception as exc:
            log.warning("telegram logout failed: %s", type(exc).__name__)
            telegram_ok = False
        store.forget_devices()
        store.set_picked([])
        log.info("wiped local session and devices (telegram logout %s)", "ok" if telegram_ok else "FAILED")
        for ws in list(hub.sockets):
            try:
                await ws.close(code=4401)
            except Exception:
                pass
        hub.sockets.clear()
        if app.state.shutdown is not None:
            app.state.shutdown()
        if not telegram_ok:
            raise HTTPException(status_code=502, detail=(
                "Local data is wiped, but Telegram didn't confirm the logout. "
                "End the session in Telegram: Settings > Devices > TapBack."))
        return {"ok": True}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        session: Session | None = None
        try:
            hello = json.loads(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT_S))
            if not isinstance(hello, dict) or hello.get("type") != "hello" or not store.is_device(hello.get("token")):
                await ws.send_text(json.dumps({"type": "error", "code": "unpaired", "human": "Pair again on your phone"}))
                await ws.close(code=4401)
                return
            hub.sockets.add(ws)
            session = Session(hub, ws)
            await ws.send_text(json.dumps(await hub.inbox()))
            while True:
                frame = await ws.receive()
                if frame["type"] == "websocket.disconnect":
                    break
                if frame.get("bytes") is not None:  # PCM audio for a dictation in progress
                    await session.audio(frame["bytes"])
                    continue
                try:
                    msg = json.loads(frame.get("text") or "null")
                except json.JSONDecodeError:
                    continue  # ignore a malformed frame rather than dropping the connection
                try:
                    await session.handle(msg if isinstance(msg, dict) else {})
                except (WebSocketDisconnect, asyncio.CancelledError):
                    raise
                except Exception as exc:
                    log.warning("request failed: %s", type(exc).__name__)
                    await session.reply({"type": "error", "code": "failed", "human": "Something went wrong"})
        except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
            pass
        finally:
            hub.sockets.discard(ws)
            if session is not None:
                session.close()

    return app
