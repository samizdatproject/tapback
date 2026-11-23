"""HTTP + WebSocket API for the glasses plugin.

The plugin pairs once with a 6-digit code printed by the backend, then sends its device
token as a Bearer header (HTTP) or in the first WebSocket message.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Protocol

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .inbox import build_inbox
from .store import Store

log = logging.getLogger("tapback.app")

TAGLINE = "TapBack: unofficial Telegram client for Even G2. Uses the Telegram API."
HELLO_TIMEOUT_S = 10


class ChatSource(Protocol):
    async def chats(self, picked: list[str]) -> list[dict]: ...


class PairBody(BaseModel):
    code: str


class PickedBody(BaseModel):
    chatIds: list[str]


class Hub:
    """Connected glasses clients; pushes a fresh inbox to all of them on change."""

    def __init__(self, tg: ChatSource, store: Store):
        self.tg, self.store = tg, store
        self.sockets: set[WebSocket] = set()

    async def inbox(self) -> dict:
        picked = self.store.picked()
        return build_inbox(await self.tg.chats(picked), picked)

    async def broadcast(self) -> None:
        if not self.sockets:
            return
        msg = json.dumps(await self.inbox())
        for ws in list(self.sockets):
            try:
                await ws.send_text(msg)
            except Exception:
                self.sockets.discard(ws)


def create_app(tg: ChatSource, store: Store) -> FastAPI:
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
            await ws.send_text(json.dumps(await hub.inbox()))
            while True:
                msg = json.loads(await ws.receive_text())
                if msg.get("type") == "open_inbox":
                    await ws.send_text(json.dumps(await hub.inbox()))
        except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
            pass
        finally:
            hub.sockets.discard(ws)

    return app
