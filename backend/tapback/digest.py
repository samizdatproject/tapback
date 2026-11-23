"""Extractive channel digest: rank new posts by engagement and show their first line verbatim.

No summarising and no AI: the text shown is the post's own first line, cut to fit.
A post dict: {id, text, views, reactions, forwards, pinned, age_h}.
"""

from __future__ import annotations

import hashlib
import math
import re
from statistics import median

TOP_N = 3
LINE_MAX = 120

_URL = re.compile(r"https?://\S+|www\.\S+")
# Emoji and pictographs don't render on the G2 font; drop them from the shown line.
_EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D\u20E3]")


def strip_emoji(text: str) -> str:
    return _EMOJI.sub("", text)


HEADING_MIN = 12  # a heading like "Market Overview:" (ends with ':' or is very short) is joined with the next line


def first_line(text: str, limit: int = LINE_MAX) -> str:
    parts: list[str] = []
    for raw in (text or "").splitlines():
        line = " ".join(_EMOJI.sub("", _URL.sub("", raw)).split()).strip(" -•|")
        if len(line) < 3:
            continue
        parts.append(line)
        if not line.endswith(":") and len(" ".join(parts)) >= HEADING_MIN:
            break
    line = " ".join(parts)
    if len(line) <= limit:
        return line
    head = line[: limit - 1]
    space = head.rfind(" ")
    return (head[:space] if space > limit * 0.6 else head).rstrip(" ,.;:") + "…"


def raw_score(p: dict) -> float:
    s = math.log1p(p.get("views") or 0) + 2 * math.log1p(p.get("reactions") or 0) + 1.5 * math.log1p(p.get("forwards") or 0)
    if p.get("pinned"):
        s += 0.5
    age = p.get("age_h") or 0
    if age > 24:
        s *= 0.5 ** ((age - 24) / 24)  # halve per extra day
    return s


def top_posts(posts: list[dict], seen_lines: set[str] | None = None, n: int = TOP_N) -> list[dict]:
    """Top n posts with a usable first line, normalised by the channel's median score.

    seen_lines collects hashes of lines already shown (across channels) so repeats are dropped.
    """
    seen = seen_lines if seen_lines is not None else set()
    scored = [(raw_score(p), p) for p in posts]
    mid = median([s for s, _ in scored]) if scored else 0
    out = []
    for s, p in sorted(scored, key=lambda sp: (-sp[0], -sp[1]["id"])):
        line = first_line(p.get("text", ""))
        if not line:
            continue
        key = hashlib.sha1(line.lower().encode()).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        out.append({"id": p["id"], "text": line, "views": p.get("views") or 0, "reactions": p.get("reactions") or 0,
                    "score": round(s / mid, 2) if mid else 0})
        if len(out) == n:
            break
    return out
