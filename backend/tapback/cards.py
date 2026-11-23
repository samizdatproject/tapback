"""Builds the glasses card for one chat from plain message dicts (unit-tested without Telegram).

A message dict: {id, sender, time, text, mine, mentions_me}.
"""

from __future__ import annotations

from . import rules

MAX_MSGS = 3
MAX_TEXT = 280


def cut(text: str, limit: int = MAX_TEXT) -> str:
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    space = head.rfind(" ")
    return (head[:space] if space > limit * 0.6 else head).rstrip(" ,.;:") + "…"


def pick_reply_target(msgs: list[dict]) -> dict | None:
    """Newest message that mentions or replies to me; else the newest one from someone else."""
    others = [m for m in msgs if not m["mine"]]
    for m in reversed(others):
        if m.get("mentions_me"):
            return m
    return others[-1] if others else None


def build_card(chat: dict, recent: list[dict], unread: int) -> dict:
    """recent: newest-first, as Telegram returns history. Shows the newest 1-3 unread (or the last one)."""
    shown_n = max(1, min(MAX_MSGS, unread))
    shown = list(reversed(recent[:shown_n]))
    msgs = [
        {"id": m["id"], "sender": m["sender"], "time": m["time"], "text": cut(m["text"]), "mine": m["mine"]}
        for m in shown
    ]
    target = pick_reply_target(shown)
    return {
        "type": "card",
        "chat": {k: chat[k] for k in ("id", "title", "kind")},
        "msgs": msgs,
        "replyTo": {"id": target["id"], "sender": target["sender"], "text": cut(target["text"], 80)} if target else None,
        "suggestions": rules.suggest(target["text"] if target else ""),
        "newCount": unread,
        "earlier": max(0, unread - len(shown)),
    }
