from tapback.digest import first_line, raw_score, top_posts


def p(i, text="Headline number %d", views=100, reactions=0, forwards=0, pinned=False, age_h=1):
    return {"id": i, "text": text % i if "%d" in text else text, "views": views, "reactions": reactions,
            "forwards": forwards, "pinned": pinned, "age_h": age_h}


def test_first_line_strips_links_emoji_and_cuts():
    assert first_line("🔥 BTC breaks $100k https://t.me/x\nmore") == "BTC breaks $100k"
    assert first_line("\n\n—\nSecond line wins") == "Second line wins"
    long = first_line("word " * 60, 50)
    assert long.endswith("…") and len(long) <= 50
    assert first_line("https://only.link") == ""


def test_ranking_prefers_engagement_and_keeps_three():
    posts = [p(1, views=50), p(2, views=5000, reactions=40), p(3, views=900, forwards=30), p(4, views=10), p(5, views=2000)]
    top = top_posts(posts)
    assert [t["id"] for t in top] == [2, 3, 5]
    assert top[0]["text"] == "Headline number 2" and top[0]["views"] == 5000


def test_old_posts_decay_and_pinned_bonus():
    assert raw_score(p(1, age_h=72)) < raw_score(p(1, age_h=1))
    assert raw_score(p(1, pinned=True)) > raw_score(p(1))


def test_cross_channel_duplicates_dropped_and_empty_lines_skipped():
    seen: set[str] = set()
    a = top_posts([p(1, text="Same story"), p(2, text="Other story")], seen)
    b = top_posts([p(3, text="same story"), p(4, text="https://x.io"), p(5, text="Fresh one")], seen)
    assert [t["text"] for t in a] == ["Same story", "Other story"] or [t["text"] for t in a] == ["Other story", "Same story"]
    assert [t["text"] for t in b] == ["Fresh one"]


def test_no_posts():
    assert top_posts([]) == []
