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
from typing import Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .inbox import build_inbox
from .store import Store

log = logging.getLogger("tapback.app")

TAGLINE = "TapBack: unofficial Telegram client for Even G2. Uses the Telegram API."
HELLO_TIMEOUT_S = 10
SENDS_PER_MINUTE = 10
MAX_TEXT = 1000
REACTIONS = {"👍"}
MUTE_MINUTES = {60, 480}
SNOOZE_MINUTES = {30, 60}


class Telegram(Protocol):
    async def chats(self, picked: list[str]) -> list[dict]: ...
    async def card(self, chat_id: str) -> dict: ...
    async def send(self, chat_id: str, reply_to: int | None, text: str | None, reaction: str | None) -> None: ...
    async def mute(self, chat_id: str, minutes: int) -> None: ...


class PairBody(BaseModel):
    code: str


class PickedBody(BaseModel):
    chatIds: list[str]


class Hub:
    """Connected glasses clients; pushes a fresh inbox to all of them on change."""

    def __init__(self, tg: Telegram, store: Store):
        self.tg, self.store = tg, store
        self.sockets: set[WebSocket] = set()

    async def inbox(self) -> dict:
        hidden = self.store.hidden()
        visible = [c for c in self.store.picked() if c not in hidden]
        return build_inbox(await self.tg.chats(visible), visible)

    async def broadcast(self) -> None:
        if not self.sockets:
            return
        msg = json.dumps(await self.inbox())
        for ws in list(self.sockets):
            try:
                await ws.send_text(msg)
            except Exception:
                self.sockets.discard(ws)


class Session:
    """One glasses connection: handles its messages and enforces its limits."""

    def __init__(self, hub: Hub, ws: WebSocket):
        self.hub, self.ws = hub, ws
        self.sends: deque[float] = deque()
        self.seen_ids: deque[str] = deque(maxlen=100)

    async def reply(self, msg: dict) -> None:
        await self.ws.send_text(json.dumps(msg))

    def _picked(self, chat_id) -> str | None:
        cid = str(chat_id or "")
        return cid if cid in self.hub.store.picked() else None

    async def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "open_inbox":
            await self.reply(await self.hub.inbox())
        elif kind == "open_chat":
            cid = self._picked(msg.get("chatId"))
            if cid is None:
                await self.reply({"type": "error", "code": "not_picked", "human": "That chat isn't picked"})
                return
            await self.reply(await self.hub.tg.card(cid))
            await self.hub.broadcast()
        elif kind == "send":
            await self.send(msg)
        elif kind in ("mute", "snooze"):
            cid = self._picked(msg.get("chatId"))
            minutes = int(msg.get("minutes") or 0)
            if cid is None or minutes not in (MUTE_MINUTES if kind == "mute" else SNOOZE_MINUTES):
                await self.reply({"type": "error", "code": "bad_request", "human": "Can't do that"})
                return
            if kind == "mute":
                await self.hub.tg.mute(cid, minutes)
            self.hub.store.hide(cid, minutes)
            await self.hub.broadcast()

    async def send(self, msg: dict) -> None:
        client_id = str(msg.get("clientMsgId") or "")[:64]
        if not client_id or client_id in self.seen_ids:
            return  # duplicate or malformed: never send twice
        self.seen_ids.append(client_id)

        def fail(human: str) -> dict:
            return {"type": "sent", "clientMsgId": client_id, "ok": False, "human": human}

        cid = self._picked(msg.get("chatId"))
        text = (msg.get("text") or "").strip()[:MAX_TEXT] or None
        reaction = msg.get("reaction") if msg.get("reaction") in REACTIONS else None
        reply_to = msg.get("replyTo") if isinstance(msg.get("replyTo"), int) else None
        if cid is None:
            await self.reply(fail("Replies go only to chats you picked"))
            return
        if not (text or reaction):
            await self.reply(fail("Nothing to send"))
            return
        now = time.monotonic()
        while self.sends and now - self.sends[0] > 60:
            self.sends.popleft()
        if len(self.sends) >= SENDS_PER_MINUTE:
            await self.reply(fail("Slow down: 10 sends a minute"))
            return
        self.sends.append(now)
        try:
            await self.hub.tg.send(cid, reply_to, text, reaction)
        except Exception as exc:
            log.warning("send failed: %s", type(exc).__name__)  # never log the text
            await self.reply(fail("Telegram didn't accept it. Try again."))
            return
        log.info("sent a %s", "reaction" if reaction else "reply")
        await self.reply({"type": "sent", "clientMsgId": client_id, "ok": True, "at": datetime.now().strftime("%H:%M")})


def create_app(tg: Telegram, store: Store) -> FastAPI:
    app = FastAPI(title="TapBack backend", docs_url=None, redoc_url=None, openapi_url=None)
    # The plugin runs in a WebView whose origin differs per platform; access is
    # controlled by the device token, not by origin, and no cookies are used.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "PUT"],
                       allow_headers=["Authorization", "Content-Type"])
    hub = Hub(tg, store)
    app.state.hub = hub

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
        return {"chats": await tg.chats(store.picked())}

    @app.put("/picked", dependencies=[Depends(device)])
    async def put_picked(body: PickedBody) -> dict:
        store.set_picked(body.chatIds[:50])
        await hub.broadcast()
        return {"ok": True}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        try:
            hello = json.loads(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT_S))
            if hello.get("type") != "hello" or not store.is_device(hello.get("token")):
                await ws.send_text(json.dumps({"type": "error", "code": "unpaired", "human": "Pair again on your phone"}))
                await ws.close(code=4401)
                return
            hub.sockets.add(ws)
            session = Session(hub, ws)
            await ws.send_text(json.dumps(await hub.inbox()))
            while True:
                msg = json.loads(await ws.receive_text())
                try:
                    await session.handle(msg if isinstance(msg, dict) else {})
                except (WebSocketDisconnect, asyncio.CancelledError):
                    raise
                except Exception as exc:
                    log.warning("request failed: %s", type(exc).__name__)
                    await ws.send_text(json.dumps({"type": "error", "code": "failed", "human": "Something went wrong"}))
        except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
            pass
        finally:
            hub.sockets.discard(ws)

    return app
