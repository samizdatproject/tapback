"""User settings for triage: VIP senders, urgent keywords and quiet hours (pure, unit-tested)."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from datetime import time

DEFAULT_KEYWORDS = ["urgent", "asap", "now", "today", "call me", "deadline", "down", "failed", "liquidat*"]  # a trailing * matches word starts
MAX_ITEMS = 30
MAX_LEN = 40
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class SettingsError(ValueError):
    pass


@dataclass(frozen=True)
class Settings:
    vip: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=lambda: list(DEFAULT_KEYWORDS))
    quiet_enabled: bool = False
    quiet_start: str = "22:00"
    quiet_end: str = "08:00"

    def to_json(self) -> dict:
        d = asdict(self)
        return {"vip": d["vip"], "keywords": d["keywords"],
                "quiet": {"enabled": d["quiet_enabled"], "start": d["quiet_start"], "end": d["quiet_end"]}}

    @classmethod
    def from_json(cls, data: dict | None) -> "Settings":
        """Validates input from the phone screen; raises SettingsError with a human message."""
        data = data or {}

        def clean_list(key: str, strip_at: bool = False) -> list[str]:
            raw = data.get(key, [])
            if not isinstance(raw, list):
                raise SettingsError(f"{key} must be a list")
            out: list[str] = []
            for item in raw:
                s = " ".join(str(item).split()).strip().lower()
                if strip_at:
                    s = s.lstrip("@")
                if not s:
                    continue
                if len(s) > MAX_LEN:
                    raise SettingsError(f"'{s[:20]}…' is longer than {MAX_LEN} characters")
                if s not in out:
                    out.append(s)
            if len(out) > MAX_ITEMS:
                raise SettingsError(f"At most {MAX_ITEMS} {key}")
            return out

        quiet = data.get("quiet") or {}
        start, end = str(quiet.get("start", "22:00")), str(quiet.get("end", "08:00"))
        if not (_TIME.match(start) and _TIME.match(end)):
            raise SettingsError("Quiet hours use HH:MM, for example 22:00")
        return cls(vip=clean_list("vip", strip_at=True),
                   keywords=clean_list("keywords") if "keywords" in data else list(DEFAULT_KEYWORDS),
                   quiet_enabled=bool(quiet.get("enabled", False)), quiet_start=start, quiet_end=end)


def keyword_pattern(keywords: list[str]) -> re.Pattern | None:
    """Whole words; a keyword ending in * also matches longer words (liquidat* → liquidated)."""
    words = [re.escape(k[:-1]) + r"\w*" if k.endswith("*") else re.escape(k) for k in keywords if k.strip("*")]
    return re.compile(r"\b(" + "|".join(words) + r")\b") if words else None


def is_vip(settings: Settings, *names: str | None) -> bool:
    """True if any of the sender's names (display name, username) is on the VIP list."""
    wanted = set(settings.vip)
    return any(n and n.strip().lstrip("@").lower() in wanted for n in names)


def _t(hhmm: str) -> time:
    h, m = hhmm.split(":")
    return time(int(h), int(m))


def in_quiet_hours(settings: Settings, now: time) -> bool:
    if not settings.quiet_enabled:
        return False
    start, end = _t(settings.quiet_start), _t(settings.quiet_end)
    if start == end:
        return False
    return start <= now < end if start < end else (now >= start or now < end)
