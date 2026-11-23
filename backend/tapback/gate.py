"""Day-1 check: proves the Telegram calls TapBack depends on work with a real account.

1. log in from the encrypted session
2. read recent history from one picked group
3. mark it read up to the newest message (send_read_acknowledge)
4. reply to the newest message (reply_to)            [skipped with --no-send]
5. fetch a sponsored message from @SecretAdTestChannel, Telegram's test channel
6. list joined channels (for the digest)

Message text is not printed; only counts, ids and channel titles.
"""

from __future__ import annotations

import argparse
import asyncio

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.messages import GetSponsoredMessagesRequest
from telethon.tl.types import Channel, Chat
from telethon.tl.types.messages import SponsoredMessages

from . import config, session_store

SPONSORED_TEST_CHANNEL = "SecretAdTestChannel"


def _step(n: int, ok: bool, detail: str) -> bool:
    print(f"[{'PASS' if ok else 'FAIL'}] {n}. {detail}")
    return ok


async def _run(cfg: config.Config, group: str, send: bool) -> bool:
    client = TelegramClient(StringSession(session_store.load(cfg.session_file, cfg.key_file)), cfg.api_id, cfg.api_hash)
    await client.connect()
    results: list[bool] = []
    try:
        authorized = await client.is_user_authorized()
        results.append(_step(1, authorized, "logged in from the encrypted session"))
        if not authorized:
            return False

        dialogs = await client.get_dialogs()
        target = next((d for d in dialogs if d.title == group and isinstance(d.entity, (Chat, Channel))), None)
        if target is None:
            results.append(_step(2, False, f"group '{group}' not found among {len(dialogs)} dialogs; stopping before any write"))
            return False

        msgs = await client.get_messages(target.entity, limit=5)
        results.append(_step(2, len(msgs) > 0, f"read {len(msgs)} recent messages from '{group}' (newest id {msgs[0].id if msgs else '-'})"))
        if not msgs:
            return False
        newest = msgs[0]

        acked = await client.send_read_acknowledge(target.entity, max_id=newest.id)
        results.append(_step(3, bool(acked), f"marked '{group}' read up to message {newest.id}"))

        if send:
            sent = await client.send_message(target.entity, "TapBack check: reply sent from the backend ✓", reply_to=newest.id)
            ok = getattr(sent.reply_to, "reply_to_msg_id", None) == newest.id
            results.append(_step(4, ok, f"replied to message {newest.id} (new message id {sent.id})"))
        else:
            print("[SKIP] 4. reply (--no-send)")

        res = await client(GetSponsoredMessagesRequest(peer=SPONSORED_TEST_CHANNEL))
        count = len(res.messages) if isinstance(res, SponsoredMessages) else 0
        detail = f"@{SPONSORED_TEST_CHANNEL} returned {count} sponsored message(s)"
        if count:
            m = res.messages[0]
            detail += f" (title: {m.title!r}, has random_id: {bool(m.random_id)})"
        results.append(_step(5, count > 0, detail))

        channels = [d for d in dialogs if isinstance(d.entity, Channel) and d.entity.broadcast]
        print(f"[INFO] 6. joined broadcast channels ({len(channels)}):")
        for d in channels:
            handle = f"@{d.entity.username}" if d.entity.username else "(private)"
            print(f"         - {d.title} {handle}")
        return all(results)
    finally:
        await client.disconnect()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m tapback gate")
    parser.add_argument("--group", default="Acme Work")
    parser.add_argument("--no-send", action="store_true")
    args = parser.parse_args(argv)
    ok = asyncio.run(_run(config.load(), args.group, not args.no_send))
    print("GATE PASSED" if ok else "GATE FAILED")
    raise SystemExit(0 if ok else 1)
