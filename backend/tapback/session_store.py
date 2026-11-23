"""The Telegram session string is stored only encrypted (AES-256-GCM).

The key lives in a separate file (mode 600) next to the session. Losing either file
means logging in again; it never means a readable session on disk.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_AAD = b"tapback-session-v1"


def _write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _key(key_file: Path, create: bool) -> bytes:
    if key_file.is_file():
        key = key_file.read_bytes()
        if len(key) != 32:
            raise SystemExit(f"{key_file} is not a 32-byte key")
        return key
    if not create:
        raise SystemExit(f"No session key at {key_file}. Run: python -m tapback login")
    key = AESGCM.generate_key(bit_length=256)
    _write_private(key_file, key)
    return key


def save(session_file: Path, key_file: Path, session_string: str) -> None:
    key = _key(key_file, create=True)
    nonce = secrets.token_bytes(12)
    _write_private(session_file, nonce + AESGCM(key).encrypt(nonce, session_string.encode(), _AAD))


def load(session_file: Path, key_file: Path) -> str:
    if not session_file.is_file():
        raise SystemExit(f"No session at {session_file}. Run: python -m tapback login")
    blob = session_file.read_bytes()
    key = _key(key_file, create=False)
    return AESGCM(key).decrypt(blob[:12], blob[12:], _AAD).decode()


def wipe(session_file: Path, key_file: Path) -> None:
    for path in (session_file, key_file):
        if path.exists():
            path.unlink()
