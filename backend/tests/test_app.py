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


class FakeTG:
    def __init__(self):
        self.sent, self.muted, self.opened = [], [], []
        self.fail = False

    async def chats(self, picked):
        return [dict(c, picked=c["id"] in picked) for c in CHATS]

    async def card(self, chat_id):
        self.opened.append(chat_id)
        return {"type": "card", "chat": {"id": chat_id}, "msgs": [], "replyTo": None, "suggestions": [], "newCount": 0, "earlier": 0}

    async def send(self, chat_id, reply_to, text, reaction):
        if self.fail:
            raise RuntimeError("boom")
        self.sent.append((chat_id, reply_to, text, reaction))

    async def mute(self, chat_id, minutes):
        self.muted.append((chat_id, minutes))

    async def digest(self, channel_ids):
        return [{"id": c, "title": "News", "newCount": 5, "top": [], "maxId": 9, "sponsored": None} for c in channel_ids]

    async def mark_read(self, chat_id, max_id):
        self.muted.append(("read", chat_id, max_id))

    async def view_sponsored(self, rid):
        self.muted.append(("view", rid))
        return True


@pytest.fixture
def env(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    tg = FakeTG()
    async def fake_stt(pcm):
        if pcm[:1] == b"x":
            raise RuntimeError("offline")
        return f"heard {len(pcm)} bytes"

    client = TestClient(create_app(tg, store, fake_stt))
    client.tg = tg
    token = client.post("/pair", json={"code": store.new_pairing_code()}).json()["token"]
    return client, store, {"Authorization": f"Bearer {token}"}, token


def test_build_inbox_picked_only_unread_first():
    inbox = build_inbox([dict(c) for c in CHATS], ["42", "-1001"])
    assert [c["title"] for c in inbox["chats"]] == ["Acme Work", "Alice"]
    assert inbox["totals"] == {"unread": 2, "chats": 1}
    assert "picked" not in inbox["chats"][0]


def test_healthz_has_tagline(env):
    client, *_ = env
    body = client.get("/healthz").json()
    assert body["ok"] and "Unofficial" in body["tagline"].title() and "Telegram API" in body["tagline"]


def test_wrong_code_and_missing_token_rejected(env):
    client, store, _, _ = env
    store.new_pairing_code()
    assert client.post("/pair", json={"code": "abc"}).status_code == 401
    assert client.get("/chats").status_code == 401
    assert client.get("/chats", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_pick_chats_then_websocket_inbox(env):
    client, store, headers, token = env
    assert len(client.get("/chats", headers=headers).json()["chats"]) == 3
    assert client.put("/picked", headers=headers, json={"chatIds": ["-1001", "42"]}).json() == {"ok": True}
    assert store.picked() == ["-1001", "42"]
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "token": token})
        inbox = ws.receive_json()
        assert inbox["type"] == "inbox" and inbox["totals"]["unread"] == 2
        ws.send_json({"type": "open_inbox"})
        assert ws.receive_json()["chats"][0]["title"] == "Acme Work"


def test_websocket_rejects_unpaired(env):
    client, *_ = env
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "hello", "token": "nope"})
        assert ws.receive_json()["code"] == "unpaired"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def _ws(client, token):
    ws = client.websocket_connect("/ws").__enter__()
    ws.send_json({"type": "hello", "token": token})
    assert ws.receive_json()["type"] == "inbox"
    return ws


def test_open_chat_only_for_picked(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "42"})
    assert ws.receive_json()["code"] == "not_picked"
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    assert ws.receive_json()["type"] == "card"
    assert ws.receive_json()["type"] == "inbox"  # counts refresh after read-on-show
    assert client.tg.opened == ["-1001"]
    ws.close()


def test_send_reply_dedupe_and_picked_only(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    ws.send_json({"type": "send", "chatId": "-1001", "replyTo": 5, "text": " Works for me ", "clientMsgId": "a1"})
    r = ws.receive_json()
    assert r["ok"] and r["clientMsgId"] == "a1"
    ws.send_json({"type": "send", "chatId": "-1001", "replyTo": 5, "text": "again", "clientMsgId": "a1"})
    ws.send_json({"type": "send", "chatId": "42", "text": "hi", "clientMsgId": "a2"})
    r = ws.receive_json()
    assert r["clientMsgId"] == "a2" and not r["ok"]
    ws.send_json({"type": "send", "chatId": "-1001", "replyTo": 5, "reaction": "👍", "clientMsgId": "a3"})
    assert ws.receive_json()["ok"]
    assert client.tg.sent == [("-1001", 5, "Works for me", None), ("-1001", 5, None, "👍")]
    ws.close()


def test_send_failure_and_rate_limit(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    client.tg.fail = True
    ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": "f"})
    assert not ws.receive_json()["ok"]
    client.tg.fail = False
    results = []
    for i in range(11):
        ws.send_json({"type": "send", "chatId": "-1001", "text": "x", "clientMsgId": f"r{i}"})
        results.append(ws.receive_json()["ok"])
    assert results.count(True) == 9 and results[-1] is False  # 10 per minute, the failed one counted
    ws.close()


def test_mute_and_snooze_hide_chat(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "mute", "chatId": "-1001", "minutes": 60})
    assert [c["id"] for c in ws.receive_json()["chats"]] == ["-1002"]
    assert client.tg.muted == [("-1001", 60)]
    ws.send_json({"type": "snooze", "chatId": "-1002", "minutes": 30})
    assert ws.receive_json()["chats"] == []
    ws.send_json({"type": "snooze", "chatId": "-1002", "minutes": 9999})
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
    assert client.tg.muted == [("read", "-1002", 9), ("view", "abc")]
    ws.close()


def test_dictation_roundtrip(env):
    client, store, _, token = env
    ws = _ws(client, token)
    ws.send_json({"type": "audio_begin"})
    for _ in range(10):
        ws.send_bytes(b"\0" * 3200)  # 10 x 100 ms
    ws.send_json({"type": "audio_end"})
    assert ws.receive_json() == {"type": "stt", "text": "heard 32000 bytes", "human": ""}
    ws.send_json({"type": "audio_begin"})
    ws.send_bytes(b"\0" * 100)
    ws.send_json({"type": "audio_end"})
    assert ws.receive_json()["human"].startswith("Too short")
    ws.send_bytes(b"\0" * 32000)  # no dictation in progress: ignored
    ws.send_json({"type": "audio_begin"})
    ws.send_bytes(b"x" * 32000)
    ws.send_json({"type": "audio_end"})
    assert ws.receive_json()["human"] == "Speech-to-text is offline"
    ws.close()
