"""Pure helpers for the glasses inbox (unit-tested without Telegram)."""

from __future__ import annotations


def build_inbox(chats: list[dict], picked: list[str]) -> dict:
    """Only picked chats; unread first, then the user's pick order."""
    order = {cid: i for i, cid in enumerate(picked)}
    rows = [
        {k: c[k] for k in ("id", "title", "kind", "unread")}
        for c in chats
        if c["id"] in order
    ]
    rows.sort(key=lambda c: (c["unread"] == 0, order[c["id"]]))
    unread = sum(c["unread"] for c in rows)
    return {
        "type": "inbox",
        "chats": rows,
        "totals": {"unread": unread, "chats": sum(1 for c in rows if c["unread"] > 0)},
    }
