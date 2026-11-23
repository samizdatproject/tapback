from tapback.cards import build_card, cut, pick_reply_target
from tapback.rules import REACT_THUMBS_UP

CHAT = {"id": "-1001", "title": "Acme Work", "kind": "group", "unread": 5}


def m(i, sender="Dana", text="hi", mine=False, mentions_me=False):
    return {"id": i, "sender": sender, "time": "14:0%d" % (i % 10), "text": text, "mine": mine, "mentions_me": mentions_me}


def test_cut_on_word_boundary():
    assert cut("short") == "short"
    out = cut("word " * 100, 40)
    assert out.endswith("…") and len(out) <= 40 and "  " not in out


def test_card_shows_newest_unread_oldest_first():
    recent = [m(5, text="Can you join the investor call at 3?"), m(4, "Lee"), m(3), m(2), m(1)]
    card = build_card(CHAT, recent, unread=5)
    assert [x["id"] for x in card["msgs"]] == [3, 4, 5]
    assert card["newCount"] == 5 and card["earlier"] == 2
    assert card["replyTo"]["id"] == 5
    assert card["suggestions"][0] == "Works for me" and card["suggestions"][-1] == REACT_THUMBS_UP
    assert card["chat"] == {"id": "-1001", "title": "Acme Work", "kind": "group"}


def test_card_with_no_unread_shows_last_message():
    card = build_card(CHAT, [m(9), m(8)], unread=0)
    assert [x["id"] for x in card["msgs"]] == [9] and card["earlier"] == 0


def test_reply_target_prefers_mentions_and_skips_mine():
    msgs = [m(1, mentions_me=True), m(2, "Lee"), m(3, "Me", mine=True)]
    assert pick_reply_target(msgs)["id"] == 1
    assert pick_reply_target([m(1, "Me", mine=True)]) is None
    assert pick_reply_target([m(1), m(2, "Lee"), m(3, "Me", mine=True)])["id"] == 2


def test_card_when_all_mine_has_no_target_and_fallback_suggestions():
    card = build_card(CHAT, [m(1, "Me", text="ok", mine=True)], unread=1)
    assert card["replyTo"] is None
    assert card["suggestions"][0] == "Got it"


def test_cut_drops_emoji_the_glasses_cannot_draw():
    assert cut("🇺🇸 JUST IN : 🔥 Arthur Hayes") == "JUST IN : Arthur Hayes"
