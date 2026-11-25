"""Pure helpers for the glasses inbox (unit-tested without Telegram)."""

from __future__ import annotations


def build_inbox(chats: list[dict], picked: list[str], hidden: set[str] | frozenset[str] = frozenset()) -> dict:
    """Picked chats plus chats that break through (unless muted or snoozed).

    Flagged first, then unread, then Later (marked unread), then the rest; ties keep the
    user's pick order, and breakthrough chats follow the picked ones in Telegram's order.
    """
    order = {cid: i for i, cid in enumerate(picked)}
    rows = []
    for c in chats:
        if c["id"] not in order:
            if not c.get("breakthrough") or c["id"] in hidden:
                continue
            order[c["id"]] = len(order)
        rows.append({
            "id": c["id"], "title": c["title"], "kind": c["kind"], "unread": c["unread"], "flag": c.get("flag", ""),
            "later": bool(c.get("later")), "breakthrough": c["id"] not in picked,
        })
    rows.sort(key=lambda c: (not c["flag"], c["unread"] == 0, not c["later"], order[c["id"]]))
    unread = sum(c["unread"] for c in rows)
    return {
        "type": "inbox",
        "chats": rows,
        "totals": {"unread": unread, "chats": sum(1 for c in rows if c["unread"] > 0)},
    }
