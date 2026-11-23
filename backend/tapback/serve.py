"""Runs the backend: Telegram client + HTTP/WebSocket API in one asyncio loop."""

from __future__ import annotations

import argparse
import asyncio
import logging

import uvicorn

from . import config
from .app import TAGLINE, create_app
from .store import Store
from .tg import Telegram


def open_store(cfg: config.Config) -> Store:
    cfg.secrets_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    return Store(cfg.secrets_dir / "tapback.sqlite")


async def _serve(host: str, port: int) -> None:
    cfg = config.load()
    store = open_store(cfg)
    tg = Telegram(cfg)
    await tg.start()
    app = create_app(tg, store)
    tg.on_change(app.state.hub.broadcast)

    print(TAGLINE)
    print(f"Listening on http://{host}:{port}")
    print(f"Pairing code (valid 5 minutes): {store.new_pairing_code()}   New code: python -m tapback pair")
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
    try:
        await server.serve()
    finally:
        await tg.stop()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tapback serve")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    asyncio.run(_serve(args.host, args.port))


def pair_main() -> None:
    store = open_store(config.load())
    print(f"Pairing code (valid 5 minutes): {store.new_pairing_code()}")
