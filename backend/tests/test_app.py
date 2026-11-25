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
        self.fail_unread = False
        self.fail_translate = False
        self.card_msgs = [7]
        self.logout_ok = True
        self.breaking = set()  # chats that break through right now (until read)
        self.marked = set()  # chats marked unread in Telegram

    async def chats(self, picked, prefs=None):
        self.last_prefs = prefs
        on = bool(prefs and prefs.breakthrough)
        return [dict(c, picked=c["id"] in picked, later=c["id"] in self.marked,
                     breakthrough=on and c["id"] in self.breaking and c["id"] not in picked) for c in CHATS]

    async def breakthrough(self, chat_id, prefs):
        self.calls.append(("check", chat_id))
        return chat_id in self.breaking

    async def mark_unread(self, chat_id, unread):
        if self.fail_unread:
            raise RuntimeError("boom")
        self.calls.append(("unread", chat_id, unread))
        (self.marked.add if unread else self.marked.discard)(chat_id)

    async def chat_kind(self, chat_id):
        return KINDS[chat_id]

    async def card(self, chat_id):
        self.calls.append(("card", chat_id))
        return {"type": "card", "chat": {"id": chat_id}, "msgs": [{"id": i} for i in self.card_msgs], "replyTo": None,
                "suggestions": ["Yes", "No", "Let me check", "React: thumbs up"], "newCount": 1, "earlier": 0, "readMaxId": 7,
                "later": chat_id in self.marked}

    async def translate(self, chat_id, ids, to_lang):
        if self.fail_translate:
            raise RuntimeError("TRANSLATE_REQ_FAILED")
        self.calls.append(("translate", chat_id, list(ids), to_lang))
        return {i: f"{to_lang}: message {i}" for i in ids if i != 8}  # 8 is media only

    async def mark_read(self, chat_id, max_id, clear_mentions=False):
        self.calls.append(("read", chat_id, max_id))
        if clear_mentions:
            self.calls.append(("clear_mentions", chat_id))
        self.breaking.discard(chat_id)  # read: it no longer qualifies

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


def test_build_inbox_orders_later_after_unread_and_adds_breakthrough():
    chats = [
        {"id": "1", "title": "Quiet", "kind": "group", "unread": 0},
        {"id": "2", "title": "Later", "kind": "user", "unread": 0, "later": True},
        {"id": "3", "title": "Busy", "kind": "group", "unread": 4},
        {"id": "4", "title": "Dana", "kind": "user", "unread": 1, "breakthrough": True},
        {"id": "5", "title": "Muted VIP", "kind": "user", "unread": 1, "breakthrough": True},
        {"id": "6", "title": "Ops", "kind": "group", "unread": 2, "flag": "!", "breakthrough": True},
        {"id": "7", "title": "Not picked", "kind": "user", "unread": 9},
    ]
    inbox = build_inbox(chats, ["1", "2", "3"], hidden={"5"})
    assert [c["title"] for c in inbox["chats"]] == ["Ops", "Busy", "Dana", "Later", "Quiet"]
    rows = {c["id"]: c for c in inbox["chats"]}
    assert rows["2"]["later"] and not rows["1"]["later"]
    assert rows["4"]["breakthrough"] and rows["6"]["breakthrough"] and not rows["3"]["breakthrough"]
    assert inbox["totals"] == {"unread": 7, "chats": 3}


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
    assert ("clear_mentions", "-1001") not in client.tg.calls  # picked: mentions are left alone
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


# --- later (marked unread in Telegram) -------------------------------------------------------

def test_later_marks_the_chat_unread_and_showing_it_clears_the_mark(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "later", "chatId": "-1001"})
    assert ws.receive_json() == {"type": "later", "chatId": "-1001", "ok": True}
    inbox = ws.receive_json()
    assert inbox["type"] == "inbox" and inbox["chats"][0]["later"] is True
    assert ("unread", "-1001", True) in client.tg.calls
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    card = _until(ws, "card")
    assert "later" not in card  # server-side only
    ws.send_json({"type": "card_shown", "chatId": "-1001", "maxId": 7})
    assert ws.receive_json()["type"] == "inbox"
    assert client.tg.calls[-2:] == [("read", "-1001", 7), ("unread", "-1001", False)]
    ws.send_json({"type": "card_shown", "chatId": "-1001", "maxId": 7})  # mark already cleared
    assert ws.receive_json()["type"] == "inbox"
    assert client.tg.calls.count(("unread", "-1001", False)) == 1
    ws.close()


def test_later_uses_the_chat_guard_and_reports_failures(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "later", "chatId": "42"})
    err = ws.receive_json()
    assert err == {"type": "error", "code": "not_picked", "human": "That chat isn't picked", "for": "later", "chatId": "42"}
    ws.send_json({"type": "later", "chatId": "-1002"})
    assert ws.receive_json()["code"] == "channel"
    client.tg.fail_unread = True
    ws.send_json({"type": "later", "chatId": "-1001"})
    err = ws.receive_json()
    assert err["type"] == "error" and err["for"] == "later" and err["human"] == "Telegram didn't accept it. Try again."
    assert not [c for c in client.tg.calls if c[0] == "unread"]
    ws.close()


# --- translate (Telegram's own translation) -------------------------------------------------------

def test_translate_uses_the_setting_and_only_ids_on_the_current_card(env):
    client, store, headers, token = env
    store.set_picked(["-1001"])
    client.put("/settings", headers=headers, json={"translate_to": "es"})
    client.tg.card_msgs = [7, 8, 9]
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    _until(ws, "card")
    # 99 isn't on the card (another chat's message, say), "7" and true aren't ids, and no client text is read.
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": [9, 7, 99, "7", True, [7], 7, 8], "text": "evil"})
    assert ws.receive_json() == {"type": "translation", "chatId": "-1001", "lang": "es",
                                 "items": [{"id": 9, "text": "es: message 9"}, {"id": 7, "text": "es: message 7"}]}
    assert [c for c in client.tg.calls if c[0] == "translate"] == [("translate", "-1001", [9, 7, 8], "es")]
    ws.close()


def test_translate_uses_the_chat_guard_and_needs_an_opened_card(env):
    client, store, _, token = env
    store.set_picked(["-1001", "-1002"])
    ws = _ws(client, token)
    ws.send_json({"type": "translate", "chatId": "42", "ids": [7]})
    assert ws.receive_json() == {"type": "error", "code": "not_picked", "human": "That chat isn't picked",
                                 "for": "translate", "chatId": "42"}
    ws.send_json({"type": "translate", "chatId": "-1002", "ids": [7]})
    assert ws.receive_json()["code"] == "channel"
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": [7]})  # no card opened yet
    err = ws.receive_json()
    assert err["code"] == "nothing_to_translate" and err["for"] == "translate" and err["human"] == "No text to translate"
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    _until(ws, "card")
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": "7"})
    assert ws.receive_json()["code"] == "nothing_to_translate"
    assert not [c for c in client.tg.calls if c[0] == "translate"]
    ws.close()


def test_translate_reports_telegram_failures_and_media_only_cards(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    client.tg.card_msgs = [8]
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    _until(ws, "card")
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": [8]})  # media only: nothing came back
    assert ws.receive_json()["human"] == "No text to translate"
    client.tg.fail_translate = True
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": [8]})
    assert ws.receive_json() == {"type": "error", "code": "translate_failed", "for": "translate", "chatId": "-1001",
                                 "human": "Telegram couldn't translate this right now"}
    ws.close()


def test_translate_still_works_after_a_reconnect(env):
    client, store, _, token = env
    store.set_picked(["-1001"])
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "-1001"})
    _until(ws, "card")
    ws.close()
    ws = _ws(client, token)  # the card is still on the glasses
    ws.send_json({"type": "translate", "chatId": "-1001", "ids": [7]})
    assert ws.receive_json()["items"] == [{"id": 7, "text": "en: message 7"}]
    ws.close()


# --- breakthrough --------------------------------------------------------------------------------

def test_breakthrough_chats_reach_the_inbox_only_when_opted_in(env):
    client, store, headers, token = env
    store.set_picked(["-1001"])
    client.tg.breaking = {"42"}
    ws = _ws(client, token)
    ws.send_json({"type": "open_inbox"})
    assert [c["id"] for c in ws.receive_json()["chats"]] == ["-1001"]
    client.put("/settings", headers=headers, json={"breakthrough": True})
    inbox = ws.receive_json()  # the settings change is broadcast
    assert [(c["id"], c["breakthrough"]) for c in inbox["chats"]] == [("-1001", False), ("42", True)]
    ws.send_json({"type": "snooze", "chatId": "42", "minutes": 30})  # TapBack snoozes apply
    assert [c["id"] for c in ws.receive_json()["chats"]] == ["-1001"]
    ws.close()


def test_a_snoozed_pick_never_comes_back_as_breakthrough(env):
    client, store, headers, token = env
    store.set_picked(["42"])
    client.put("/settings", headers=headers, json={"breakthrough": True})
    client.tg.breaking = {"42"}
    store.hide("42", 30)
    ws = _ws(client, token)
    ws.send_json({"type": "open_inbox"})
    assert ws.receive_json()["chats"] == []
    ws.close()


def test_breakthrough_chat_can_be_opened_read_and_answered(env):
    client, store, headers, token = env
    client.put("/settings", headers=headers, json={"breakthrough": True})
    client.tg.breaking = {"42"}
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "42"})
    assert _until(ws, "card")["chat"]["id"] == "42"
    ws.send_json({"type": "card_shown", "chatId": "42", "maxId": 7})  # read receipt, as for picked chats
    assert ws.receive_json()["type"] == "inbox"
    assert ("read", "42", 7) in client.tg.calls and "42" not in client.tg.breaking
    assert ("clear_mentions", "42") in client.tg.calls  # not picked: its mention counter is cleared too
    # Read now, so it no longer qualifies; the server's own earlier check still lets the reply out.
    ws.send_json({"type": "send", "chatId": "42", "replyTo": 7, "text": "On my way", "clientMsgId": "b1"})
    assert ws.receive_json()["ok"]
    ws.send_json({"type": "later", "chatId": "42"})
    assert ws.receive_json()["ok"]
    assert client.tg.calls.count(("check", "42")) == 1
    ws.close()


def test_breakthrough_is_checked_on_the_server_never_trusted(env):
    client, store, headers, token = env
    client.tg.breaking = {"42", "-1002"}
    ws = _ws(client, token)
    ws.send_json({"type": "open_chat", "chatId": "42"})  # setting is off
    assert ws.receive_json()["code"] == "not_picked"
    ws.send_json({"type": "send", "chatId": "42", "text": "hi", "clientMsgId": "x1"})
    assert not ws.receive_json()["ok"]
    client.put("/settings", headers=headers, json={"breakthrough": True})
    ws.receive_json()  # broadcast inbox
    ws.send_json({"type": "open_chat", "chatId": "-1001"})  # unpicked and doesn't qualify
    assert ws.receive_json()["code"] == "not_picked"
    ws.send_json({"type": "open_chat", "chatId": "-1002"})  # channels stay excluded
    assert ws.receive_json()["code"] == "channel"
    ws.send_json({"type": "open_chat", "chatId": "not-a-number"})
    assert ws.receive_json()["code"] == "not_picked"
    assert client.tg.sends() == []
    ws.send_json({"type": "open_chat", "chatId": "42"})
    assert _until(ws, "card")["chat"]["id"] == "42"
    client.put("/settings", headers=headers, json={"breakthrough": False})
    ws.receive_json()
    ws.send_json({"type": "open_chat", "chatId": "42"})  # turning it off ends earlier checks too
    assert ws.receive_json()["code"] == "not_picked"
    ws.close()
