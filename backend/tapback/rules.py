"""Deterministic rules: reply suggestions and triage. No AI, no ML, no network.

Telegram's API terms forbid feeding Telegram data to AI models, so every suggestion
comes from these published rules and nothing else.
"""

from __future__ import annotations

import re

REACT_THUMBS_UP = "React: thumbs up"
MAX_SUGGESTIONS = 5

URGENT = re.compile(r"\b(urgent|asap|now|today|call me|deadline|down|failed|liquidat\w*)\b")

# (name, trigger, suggestions). The first two rules that match contribute; order = priority.
RULES: list[tuple[str, re.Pattern, list[str]]] = [
    ("time", re.compile(r"(\bat\s?\d{1,2}(:\d\d)?\s?(am|pm)?\b|\b\d{1,2}\s?(am|pm)\b|\btomorrow\b|\btonight\b|\bin \d+ ?min).*\?"),
     ["Works for me", "Can we do later?", "Can't make it"]),
    ("where", re.compile(r"where are you|\beta\b|on your way|\bcoming\?"),
     ["On my way", "5 min away", "Running late"]),
    ("call", re.compile(r"call me|can you call|quick call|ring me"),
     ["Call you in 10", "Can't call now, text me"]),
    ("review", re.compile(r"please (check|review|look)|can you (check|look)|\bpr\b|\bdoc\b|\bdeck\b|\bslide"),
     ["Will look today", "On it"]),
    ("yesno", re.compile(r"^(can|could|will|would|are|is|do|does|did|should|shall|have|any chance)\b.*\?$"),
     ["Yes", "No", "Let me check"]),
    ("thanks", re.compile(r"^(thanks|thank you|thx|ty)\b"),
     ["Anytime", "You're welcome"]),
    ("urgent", URGENT,
     ["On it", "Calling soon"]),
    ("question", re.compile(r"\?$|^(what|when|where|who|why|how|which)\b"),
     ["Let me check", "Will reply soon"]),
]
FALLBACK = ["Got it", "Thanks!", "Will reply later"]

_URL = re.compile(r"https?://\S+|www\.\S+")
_SPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    return _SPACE.sub(" ", _URL.sub("", text or "").lower()).strip()


def matched_rules(text: str) -> list[str]:
    t = normalise(text)
    return [name for name, pattern, _ in RULES if pattern.search(t)]


def suggest(text: str) -> list[str]:
    """Up to 5 replies from at most two matching rules, then the fallback, then a reaction."""
    t = normalise(text)
    out: list[str] = []
    used = 0
    for _name, pattern, replies in RULES:
        if used == 2:
            break
        if pattern.search(t):
            used += 1
            out += [r for r in replies if r not in out]
    if not out:
        out = list(FALLBACK)
    return out[:MAX_SUGGESTIONS] + [REACT_THUMBS_UP]


def is_urgent(text: str) -> bool:
    return bool(URGENT.search(normalise(text)))
