import pytest

from tapback.rules import REACT_THUMBS_UP, is_urgent, matched_rules, normalise, suggest


@pytest.mark.parametrize(
    "text, first",
    [
        ("Can you join the investor call at 3?", "Works for me"),
        ("where are you?", "On my way"),
        ("What's your ETA", "On my way"),
        ("Call me when you can", "Call you in 10"),
        ("Deck is in the shared folder, can you check slide 4?", "Will look today"),
        ("Are you free?", "Yes"),
        ("Thanks for the intro!", "Anytime"),
        ("Server is down", "On it"),
        ("Which venue did we pick?", "Let me check"),
        ("Nice photo", "Got it"),
    ],
)
def test_first_suggestion(text, first):
    out = suggest(text)
    assert out[0] == first
    assert out[-1] == REACT_THUMBS_UP
    assert len(out) <= 6 and len(set(out)) == len(out)


def test_two_rules_contribute_and_cap_at_five():
    out = suggest("Can you join the call at 3? Please review the deck too?")
    assert out[:3] == ["Works for me", "Can we do later?", "Can't make it"]
    assert "Will look today" in out
    assert len(out) == 6


def test_urls_are_ignored():
    assert normalise("Look https://example.com/a?b  NOW") == "look now"
    assert matched_rules("see https://x.io/where-are-you") == []


def test_urgent():
    assert is_urgent("Liquidation risk on the BTC long")
    assert not is_urgent("lunch tomorrow")
