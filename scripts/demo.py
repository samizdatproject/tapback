#!/usr/bin/env python3
"""Drives a repeatable TapBack demo: demo bots send messages, the Even Hub simulator gets inputs.

Needs a running backend (paired) and the simulator started with --automation-port.
Demo senders are two Telegram bots you own: a work bot that is admin in the demo group
and posts there, and a second bot that DMs the demo account (which must have pressed Start).

    TAPBACK_ENV=~/.config/tapback/tapback.env python3 scripts/demo.py --token-file devtoken
    env file: TG_WORK_BOT_TOKEN, TG_ALICE_BOT_TOKEN (plus the backend's TG_API_ID / TG_API_HASH)

--step waits for Enter before each scene, so you can start or pause a screen recording.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path


def env_file(path: str) -> dict[str, str]:
    values = {}
    for line in Path(path).expanduser().read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip()
    return values


class Demo:
    def __init__(self, args: argparse.Namespace):
        self.env = env_file(args.env)
        self.backend = args.backend.rstrip("/")
        self.sim = args.sim.rstrip("/")
        self.token = Path(args.token_file).read_text().strip()
        self.step = args.step
        self.pace = args.pace
        self.group = args.group
        self.dm = args.dm
        self.shots = Path(args.shots) if args.shots else None
        self.n = 0

    # plumbing ---------------------------------------------------------------------
    def _get(self, url: str, headers: dict | None = None) -> dict:
        return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=20))

    def bot(self, which: str, method: str, **params) -> dict:
        token = self.env[f"TG_{which}_BOT_TOKEN"]
        data = urllib.parse.urlencode(params).encode()
        res = json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{token}/{method}", data, timeout=20))
        if not res.get("ok"):
            raise SystemExit(f"bot {which} {method} failed")
        return res["result"]

    def chats(self) -> dict[str, dict]:
        res = self._get(f"{self.backend}/chats", {"Authorization": f"Bearer {self.token}"})
        return {c["title"]: c for c in res["chats"]}

    def dm_chat_id(self) -> int:
        for u in reversed(self.bot("ALICE", "getUpdates")):
            chat = (u.get("message") or {}).get("chat") or {}
            if chat.get("type") == "private":
                return chat["id"]
        raise SystemExit("The DM bot has no private chat yet: press Start on it from the demo account.")

    def tap(self, action: str, wait: float = 1.2) -> None:
        req = urllib.request.Request(f"{self.sim}/api/input", json.dumps({"action": action}).encode(),
                                     {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
        self.sleep(wait)

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds * self.pace)

    def shot(self, name: str) -> None:
        if not self.shots:
            return
        self.shots.mkdir(parents=True, exist_ok=True)
        self.n += 1
        data = urllib.request.urlopen(f"{self.sim}/api/screenshot/glasses", timeout=10).read()
        (self.shots / f"{self.n:02d}-{name}.png").write_bytes(data)

    def scene(self, title: str) -> None:
        print(f"\n== {title}")
        if self.step:
            input("   press Enter to run this scene… ")

    def say(self, text: str) -> None:
        if sys.platform == "darwin":
            subprocess.run(["say", text], check=False)
        else:
            print(f"   (speak now: {text!r})")
            self.sleep(3)

    # scenes -----------------------------------------------------------------------
    def run(self) -> None:
        chats = self.chats()
        if self.group not in chats or self.dm not in chats:
            raise SystemExit(f"Need picked chats named {self.group!r} and {self.dm!r}.")
        group_id = chats[self.group]["id"]
        dm_id = self.dm_chat_id()

        self.scene("1. Inbox: a work message arrives")
        self.bot("WORK", "sendMessage", chat_id=group_id, text="Can you join the investor call at 3?")
        self.sleep(4)  # the backend pushes a fresh inbox within about 2 s
        self.tap("context_menu", 1.0)
        self.tap("click", 2.0)  # menu: Refresh, so the new chat is at the top
        self.shot("inbox")

        self.scene("2. Glance, tap, tap: reply with undo")
        self.tap("click", 2.5)  # open the top chat: the card
        self.shot("card")
        self.tap("click", 2.0)  # quick replies
        self.shot("replies")
        self.bot("ALICE", "sendMessage", chat_id=dm_id, text="where are you?")  # queued for the next scene
        self.tap("click", 0.8)  # first suggestion: "Works for me"
        self.shot("undo")
        self.sleep(2.5)
        self.shot("sent")
        self.sleep(2.5)  # the next chat with unread opens: Alice
        self.shot("next-card")

        self.scene("3. Hold to talk: dictate a reply")
        self.tap("long_press", 0.6)
        self.say("Running ten minutes late, start without me")
        self.sleep(0.5)
        self.shot("listening")
        self.tap("long_press_release", 3.0)
        self.shot("preview")
        self.tap("click", 0.8)  # send the transcript (undo window)
        self.sleep(3.0)
        self.shot("dictation-sent")

        self.scene("4. Digest: top posts and the sponsored message")
        self.tap("double_click", 2.0)  # back to the Inbox
        rows = len([c for c in self.chats().values() if c["picked"]])
        for _ in range(rows):  # the Digest row is last
            self.tap("down", 0.4)
        self.tap("click", 6.0)  # loading the digest takes a few seconds
        self.shot("digest")
        for i in range(3):
            self.tap("down", 2.5)
            self.shot(f"digest-{i + 2}")
        # No double-tap here: past the last page the digest is already back on the Inbox,
        # where a double-tap opens the exit dialog.
        print("\nDone.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env", default=os.environ.get("TAPBACK_ENV", "~/.config/tapback/tapback.env"))
    p.add_argument("--token-file", required=True, help="file holding a paired device token")
    p.add_argument("--backend", default="http://localhost:8787")
    p.add_argument("--sim", default="http://localhost:9898")
    p.add_argument("--group", default="Acme Work")
    p.add_argument("--dm", default="Alice")
    p.add_argument("--pace", type=float, default=1.0, help="multiply every wait (e.g. 1.5 for a slower video)")
    p.add_argument("--step", action="store_true", help="wait for Enter before each scene")
    p.add_argument("--shots", help="save a glasses screenshot after each step into this folder")
    Demo(p.parse_args()).run()


if __name__ == "__main__":
    main()
