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
    async def chats(self, picked):
        return [dict(c, picked=c["id"] in picked) for c in CHATS]


@pytest.fixture
def env(tmp_path):
    store = Store(tmp_path / "db.sqlite")
    client = TestClient(create_app(FakeTG(), store))
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
