"""Settings come from environment variables, optionally loaded from an env file.

TAPBACK_ENV       path to an env file (KEY=value lines). Default: ./tapback.env
TG_API_ID         your own api_id from my.telegram.org
TG_API_HASH       your own api_hash
TAPBACK_SECRETS   directory for the encrypted session and its key.
                  Default: the env file's directory.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str
    secrets_dir: Path

    @property
    def session_file(self) -> Path:
        return self.secrets_dir / "session.enc"

    @property
    def key_file(self) -> Path:
        return self.secrets_dir / "session.key"


def load() -> Config:
    env_path = Path(os.environ.get("TAPBACK_ENV", "tapback.env")).expanduser()
    values = _read_env_file(env_path)
    values.update({k: v for k, v in os.environ.items() if k.startswith(("TG_", "TAPBACK_"))})

    missing = [k for k in ("TG_API_ID", "TG_API_HASH") if not values.get(k)]
    if missing:
        raise SystemExit(
            f"Missing {', '.join(missing)}. Set them in the environment or in the env file "
            f"({env_path}); get them at https://my.telegram.org."
        )

    secrets_dir = Path(values.get("TAPBACK_SECRETS") or env_path.parent).expanduser()
    return Config(api_id=int(values["TG_API_ID"]), api_hash=values["TG_API_HASH"], secrets_dir=secrets_dir)
