"""Pure helpers for the glasses inbox (unit-tested without Telegram)."""

from __future__ import annotations


def build_inbox(chats: list[dict], picked: list[str]) -> dict:
    """Only picked chats; flagged first, then unread, then the user's pick order."""
    order = {cid: i for i, cid in enumerate(picked)}
    rows = [
        {"id": c["id"], "title": c["title"], "kind": c["kind"], "unread": c["unread"], "flag": c.get("flag", "")}
        for c in chats
        if c["id"] in order
    ]
    # Flagged (mention or urgent) first, then other unread chats, each in the user's pick order.
    rows.sort(key=lambda c: (not c["flag"], c["unread"] == 0, order[c["id"]]))
    unread = sum(c["unread"] for c in rows)
    return {
        "type": "inbox",
        "chats": rows,
        "totals": {"unread": unread, "chats": sum(1 for c in rows if c["unread"] > 0)},
    }
