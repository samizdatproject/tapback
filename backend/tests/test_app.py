import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tapback.app import create_app
from tapback.inbox import build_inbox
from tapback.store import Store

CHATS = [
    {"id": "-1001", "title": "Acme Work", "kind": "group", "unread": 2, "picked": False},
    {"id": "42", "title": "Alice", "kind": "user", "unread": 0, "picked": False},
    {"id": "-1002", "title": "News", "kind": "channel", "unread": 5, "picked": False},
]
KINDS = {c["id"]: c["kind"] for c in CHATS}


class FakeTG:
    def __init__(self):
        self.calls = []
        self.fail_send = False
        self.logout_ok = True

    async def chats(self, picked, prefs=None):
        self.last_prefs = prefs
        return [dict(c, picked=c["id"] in picked) for c in CHATS]

    async def chat_kind(self, chat_id):
        return KINDS[chat_id]

    async def card(self, chat_id):
        self.calls.append(("card", chat_id))
        return {"type": "card", "chat": {"id": chat_id}, "msgs": [{"id": 7}], "replyTo": None,
                "suggestions": ["Yes", "No", "Let me check", "React: thumbs up"], "newCount": 1, "earlier": 0, "readMaxId": 7}

    async def mark_read(self, chat_id, max_id):
        self.calls.append(("read", chat_id, max_id))

    async def send(self, chat_id, reply_to, text, reaction):
        if self.fail_send:
            raise RuntimeError("boom")
        self.calls.append(("send", chat_id, reply_to, text, reaction))

    async def mute(self, chat_id, minutes):
        self.calls.append(("mute", chat_id, minutes))

    async def digest(self, channel_ids):
        return [{"id": c, "title": "News", "newCount": 5, "top": [], "maxId": 9, "sponsored": None} for c in channel_ids]

    async def view_sponsored(self, rid):
        self.calls.append(("view", rid))
        return True

    async def log_out(self):
        self.calls.append(("logout",))
        return self.logout_ok

    def sends(self):
        return [c for c in self.calls if c[0] == "send"]


async def fake_stt(pcm):
    if pcm[:1] == b"x":
        raise RuntimeError("offline")
    return f"heard {len(pcm)} bytes"


@pytest.fixture
def env(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    tg = FakeTG()
    client = TestClient(create_app(tg, store, fake_stt))
    client.tg = tg
    token = client.post("/pair", json={"code": store.new_pairing_code()}).json()["token"]
    return client, store, {"Authorization": f"Bearer {token}"}, token


def _ws(client, token):
    ws = client.websocket_connect("/ws").__enter__()
    ws.send_json({"type": "hello", "token": token})
    assert ws.receive_json()["type"] == "inbox"
    return ws


def _until(ws, kind):
    while True:
        m = ws.receive_json()
        if m["type"] == kind:
            return m


# --- inbox, pairing, picking ------------------------------------------------------

def test_build_inbox_picked_only_flagged_then_unread_first():
    inbox = build_inbox([dict(c) for c in CHATS], ["42", "-1001"])
    assert [c["title"] for c in inbox["chats"]] == ["Acme Work", "Alice"]
    assert inbox["totals"] == {"unread": 2, "chats": 1}
    assert "picked" not in inbox["chats"][0]
    flagged = build_inbox([dict(c, flag="!" if c["id"] == "42" else "") for c in CHATS], ["-1001", "42"])
    assert [c["title"] for c in flagged["chats"]] == ["Alice", "Acme Work"]


def test_healthz_has_tagline(env):
    client, *_ = env
    body = client.get("/healthz").json()
    assert body["ok"] and "unofficial" in body["tagline"].lower() and "Telegram API" in body["tagline"]


def test_wrong_code_and_missing_token_rejected(env):
    client, store, _, _ = env
    store.new_pairing_code()
    assert client.post("/pair", json={"code": "abc"}).status_code == 401
    assert client.get("/chats").status_code == 401
    assert client.get("/chats", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_picks_are_validated_against_real_dialogs(env):
    client, store, headers, token = env
    r = client.put("/picked", headers=headers, json={"chatIds": ["-1001", "42", "999", "42"]})
    assert r.json() == {"ok": True, "picked": 2}
    assert store.picked() == ["-1001", "42"]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "token": token})
        assert ws.receive_json()["totals"]["unread"] == 2


def test_websocket_rejects_unpaired_and_bad_hello(env):
    client, *_ = env
    for hello in ({"type": "hello", "token": "nope"}, ["not", "an", "object"]):
        with client.websocket_connect("/ws") as ws:
            ws.send_json(hello)
            assert ws.receive_json()["code"] == "unpaired"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()


def test_malformed_frame_does_not_drop_the_connection(env):
    client, _, _, token = env
    ws = _ws(client, token)
    ws.send_text("{not json")
    ws.send_json({"type": "open_inbox"})
    assert ws.receive_json()["type"] == "inbox"
    ws.close()


# --- cards and read state -----------------------------------------------------------

def test_open_chat_marks_read_only_when_card_shown(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "42"})
    err = ws.receive_json()
    assert err["code"] == "not_picked" and err["for"] == "open_chat" and err["chatId"] == "42"
    ws.send_json({"type": "open_chat", "chatId": "-1002"})
    assert ws.receive_json()["code"] == "channel"
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    card = ws.receive_json()
    assert card["type"] == "card" and card["readMaxId"] == 7
    assert not [c for c in client.tg.calls if c[0] == "read"]  # nothing marked read yet
    ws.send_json({"type": "card_shown", "chatId": "-1001", "maxId": 7})
    assert ws.receive_json()["type"] == "inbox"
    assert ("read", "-1001", 7) in client.tg.calls
    ws.close()


# --- sending ------------------------------------------------------------------------------

def test_send_reply_and_reaction_only_to_picked_non_channels(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "send", "chatId": "-1001", "replyTo": 5, "text": " Works for me ", "clientMsgId": "a1"})
    assert ws.receive_json()["ok"]
    ws.send_json({"type": "send", "chatId": "42", "text": "hi", "clientMsgId": "a2"})
    assert not ws.receive_json()["ok"]
    ws.send_json({"type": "send", "chatId": "-1002", "text": "hi", "clientMsgId": "a3"})
    assert ws.receive_json()["human"] == "You can't reply to a channel"
    ws.send_json({"type": "send", "chatId": "-1001", "replyTo": 5, "reaction": "👍", "clientMsgId": "a4"})
    assert ws.receive_json()["ok"]
    assert client.tg.sends() == [("send", "-1001", 5, "Works for me", None), ("send", "-1001", 5, None, "👍")]
    ws.close()


def test_retry_with_same_id_never_sends_twice(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    ws.send_json({"type": "send", "chatId": "-1001", "text": "On it", "clientMsgId": "r1"})
    ws.send_json({"type": "send", "chatId": "-1001", "text": "On it", "clientMsgId": "r1"})
    first, second = ws.receive_json(), ws.receive_json()
    assert first == second and first["ok"]
    ws.close()
    ws2 = _ws(client, token)  # a reconnect keeps the result too
    ws2.send_json({"type": "send", "chatId": "-1001", "text": "On it", "clientMsgId": "r1"})
    assert ws2.receive_json()["ok"]
    assert len(client.tg.sends()) == 1
    ws2.close()


def test_failed_send_can_be_retried_with_same_id(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    client.tg.fail_send = True
    ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": "f"})
    assert not ws.receive_json()["ok"]
    client.tg.fail_send = False
    ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": "f"})
    assert ws.receive_json()["ok"]
    assert len(client.tg.sends()) == 1
    ws.close()


def test_rate_limit_is_shared_across_reconnects(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    for i in range(6):
        ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": f"a{i}"})
        assert ws.receive_json()["ok"]
    ws.close()
    ws = _ws(client, token)
    results = []
    for i in range(5):
        ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": f"b{i}"})
        results.append(ws.receive_json()["ok"])
    assert results == [True, True, True, True, False]
    ws.close()


# --- mute, digest, dictation ----------------------------------------------------------

def test_mute_and_snooze_hide_chat(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "mute", "chatId": "-1001", "minutes": 60})
    assert [c["id"] for c in ws.receive_json()["chats"]] == ["-1002"]
    assert ("mute", "-1001", 60) in client.tg.calls
    ws.send_json({"type": "snooze", "chatId": "-1002", "minutes": 30})
    assert ws.receive_json()["chats"] == []
    ws.send_json({"type": "snooze", "chatId": "-1002", "minutes": "lots"})
    assert ws.receive_json()["code"] == "bad_request"
    ws.close()


def test_digest_only_picked_channels_and_explicit_done(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "digest_open"})
    d = ws.receive_json()
    assert d["type"] == "digest" and [c["id"] for c in d["channels"]] == ["-1002"]
    ws.send_json({"type": "digest_done", "channelId": "-1002", "maxId": 9})
    assert ws.receive_json()["type"] == "inbox"
    ws.send_json({"type": "digest_done", "channelId": "42", "maxId": 9})  # not picked: ignored
    ws.send_json({"type": "sponsored_viewed", "randomId": "abc"})
    ws.send_json({"type": "open_inbox"})
    assert ws.receive_json()["type"] == "inbox"
    assert ("read", "-1002", 9) in client.tg.calls and ("view", "abc") in client.tg.calls
    ws.close()


def test_dictation_roundtrip_echoes_id(env):
    client, store, _, token = env
    ws = _ws(client, token)
    ws.send_json({"type": "audio_begin", "id": "d1"})
    for _ in range(10):
        ws.send_bytes(b"\0" * 3200)  # 10 x 100 ms
    ws.send_json({"type": "audio_end"})
    assert _until(ws, "stt") == {"type": "stt", "id": "d1", "text": "heard 32000 bytes", "human": ""}
    ws.send_json({"type": "audio_begin", "id": "d2"})
    ws.send_bytes(b"\0" * 100)
    ws.send_json({"type": "audio_end"})
    short = _until(ws, "stt")
    assert short["id"] == "d2" and short["human"].startswith("Too short")
    ws.send_bytes(b"\0" * 32000)  # no dictation in progress: ignored
    ws.send_json({"type": "audio_begin", "id": "d3"})
    ws.send_bytes(b"x" * 32000)
    ws.send_json({"type": "audio_end"})
    assert _until(ws, "stt") == {"type": "stt", "id": "d3", "text": "", "human": "Speech-to-text is offline"}
    ws.close()


# --- log out & wipe -------------------------------------------------------------------------

def test_logout_wipes_devices_and_picks(env):
    client, store, headers, token = env
    store.set_picked(["-1001"])
    assert client.post("/logout").status_code == 401
    assert client.post("/logout", headers=headers).json() == {"ok": True}
    assert ("logout",) in client.tg.calls
    assert store.picked() == [] and not store.is_device(token)
    assert client.get("/chats", headers=headers).status_code == 401


def test_logout_reports_when_telegram_did_not_confirm(env):
    client, store, headers, token = env
    client.tg.logout_ok = False
    r = client.post("/logout", headers=headers)
    assert r.status_code == 502 and "Devices" in r.json()["detail"]
    assert not store.is_device(token)  # local data is wiped either way


# --- settings and learning -------------------------------------------------------------

def test_settings_roundtrip_and_validation(env):
    client, store, headers, token = env
    assert client.get("/settings").status_code == 401
    assert client.get("/settings", headers=headers).json()["quiet"]["enabled"] is False
    body = {"vip": ["@Dana"], "keywords": ["outage"], "quiet": {"enabled": True, "start": "22:00", "end": "07:30"}}
    r = client.put("/settings", headers=headers, json=body).json()
    assert r["ok"] and r["vip"] == ["dana"] and r["quiet"]["end"] == "07:30"
    assert store.settings().keywords == ["outage"]
    bad = client.put("/settings", headers=headers, json={"quiet": {"start": "9pm"}})
    assert bad.status_code == 400 and "HH:MM" in bad.json()["detail"]


def test_inbox_carries_quiet_state_and_prefs_reach_flags(env):
    client, store, headers, token = env
    client.put("/settings", headers=headers, json={"vip": ["dana"], "quiet": {"enabled": True, "start": "00:00", "end": "23:59"}})
    ws = _ws(client, token)
    ws.send_json({"type": "open_inbox"})
    inbox = ws.receive_json()
    assert inbox["quiet"]["until"] == "23:59" and isinstance(inbox["quiet"]["active"], bool)
    assert client.tg.last_prefs.vip == ["dana"]
    ws.close()


def test_reply_choices_are_learned_per_chat(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    for i in range(2):
        ws.send_json({"type": "send", "chatId": "-1001", "text": "Let me check", "clientMsgId": f"l{i}"})
        assert ws.receive_json()["ok"]
    ws.send_json({"type": "send", "chatId": "-1001", "text": "free text is never counted", "clientMsgId": "f1"})
    assert ws.receive_json()["ok"]
    assert store.reply_counts("-1001") == {"Let me check": 2}
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    card = _until(ws, "card")
    assert card["suggestions"] == ["Let me check", "Yes", "No", "React: thumbs up"]
    ws.close()
