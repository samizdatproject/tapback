"""Small SQLite store: picked chats, paired device tokens and the current pairing code.

No message text is ever written here. Tokens and pairing codes are stored as SHA-256 hashes.
"""

from __future__ import annotations

import hashlib
import os
import hmac
import secrets
import sqlite3
import threading
import time
from pathlib import Path

PAIR_TTL_S = 300
PAIR_MAX_ATTEMPTS = 5


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Store:
    def __init__(self, path: Path | str, clock=time.time):
        self._clock = clock
        self._lock = threading.Lock()
        path = Path(path)
        path.touch(mode=0o600, exist_ok=True)
        os.chmod(path, 0o600)  # also tightens a file created by an older version
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS picked (chat_id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS pairing (id INTEGER PRIMARY KEY CHECK (id = 1),
                code_hash TEXT NOT NULL, expires REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS hidden (chat_id TEXT PRIMARY KEY, until REAL NOT NULL);
            """
        )

    # muted / snoozed chats (hidden from the glasses until a time) -------------------
    def hide(self, chat_id: str, minutes: int) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO hidden(chat_id, until) VALUES (?, ?)",
                             (chat_id, self._clock() + minutes * 60))

    def hidden(self) -> set[str]:
        with self._lock:
            now = self._clock()
            self._db.execute("DELETE FROM hidden WHERE until <= ?", (now,))
            return {r[0] for r in self._db.execute("SELECT chat_id FROM hidden")}

    # picked chats -----------------------------------------------------------------
    def picked(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self._db.execute("SELECT chat_id FROM picked ORDER BY rowid")]

    def set_picked(self, chat_ids: list[str]) -> None:
        with self._lock:
            self._db.execute("BEGIN")
            self._db.execute("DELETE FROM picked")
            self._db.executemany("INSERT OR IGNORE INTO picked(chat_id) VALUES (?)", [(c,) for c in chat_ids])
            self._db.execute("COMMIT")

    # pairing ----------------------------------------------------------------------
    def new_pairing_code(self) -> str:
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO pairing(id, code_hash, expires, attempts) VALUES (1, ?, ?, 0)",
                (_h(code), self._clock() + PAIR_TTL_S),
            )
        return code

    def redeem_pairing_code(self, code: str) -> str | None:
        """Returns a new device token if the code is right; the code is single use."""
        with self._lock:
            row = self._db.execute("SELECT code_hash, expires, attempts FROM pairing WHERE id = 1").fetchone()
            if row is None:
                return None
            code_hash, expires, attempts = row
            if self._clock() > expires or attempts >= PAIR_MAX_ATTEMPTS:
                self._db.execute("DELETE FROM pairing WHERE id = 1")
                return None
            if not hmac.compare_digest(code_hash, _h(code.strip())):
                self._db.execute("UPDATE pairing SET attempts = attempts + 1 WHERE id = 1")
                return None
            self._db.execute("DELETE FROM pairing WHERE id = 1")
            token = secrets.token_urlsafe(32)
            self._db.execute("INSERT INTO devices(token_hash, created) VALUES (?, ?)", (_h(token), self._clock()))
            return token

    # devices ----------------------------------------------------------------------
    def is_device(self, token: str | None) -> bool:
        if not token:
            return False
        with self._lock:
            return self._db.execute("SELECT 1 FROM devices WHERE token_hash = ?", (_h(token),)).fetchone() is not None

    def forget_devices(self) -> None:
        with self._lock:
            self._db.execute("DELETE FROM devices")
