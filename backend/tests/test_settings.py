from datetime import time

import pytest

from tapback.settings import DEFAULT_KEYWORDS, Settings, SettingsError, in_quiet_hours, is_vip, keyword_pattern


def test_defaults_and_roundtrip():
    s = Settings()
    assert s.keywords == DEFAULT_KEYWORDS and not s.quiet_enabled
    again = Settings.from_json(s.to_json())
    assert again == s


def test_from_json_cleans_and_validates():
    s = Settings.from_json({"vip": [" @Dana ", "dana", "", "Lee"], "keywords": ["Outage", "outage", "P1"],
                            "quiet": {"enabled": True, "start": "21:30", "end": "07:00"}})
    assert s.vip == ["dana", "lee"] and s.keywords == ["outage", "p1"]
    assert s.quiet_enabled and s.quiet_start == "21:30"
    with pytest.raises(SettingsError):
        Settings.from_json({"quiet": {"start": "25:00"}})
    with pytest.raises(SettingsError):
        Settings.from_json({"vip": ["x" * 41]})
    with pytest.raises(SettingsError):
        Settings.from_json({"vip": [f"v{i}" for i in range(31)]})
    with pytest.raises(SettingsError):
        Settings.from_json({"keywords": "outage"})


def test_breakthrough_is_opt_in_and_validated():
    assert Settings().breakthrough is False
    assert Settings.from_json({}).breakthrough is False
    s = Settings.from_json({"breakthrough": True})
    assert s.breakthrough is True and s.to_json()["breakthrough"] is True
    assert Settings.from_json(s.to_json()) == s
    with pytest.raises(SettingsError):
        Settings.from_json({"breakthrough": "yes"})


def test_keyword_pattern_matches_word_starts():
    p = keyword_pattern(["down", "liquidat*", "call me"])
    assert p.search("prod is down")
    assert p.search("position got liquidated")
    assert p.search("can you call me")
    assert not p.search("download done")  # no match inside other words
    assert keyword_pattern([]) is None


def test_vip_matches_name_or_username():
    s = Settings(vip=["dana", "cfo_lee"])
    assert is_vip(s, "Dana", None)
    assert is_vip(s, "Lee Park", "@CFO_Lee")
    assert not is_vip(s, "Alice", "alice")


@pytest.mark.parametrize("start,end,now,expected", [
    ("22:00", "08:00", time(23, 0), True),
    ("22:00", "08:00", time(7, 59), True),
    ("22:00", "08:00", time(8, 0), False),
    ("13:00", "14:00", time(13, 30), True),
    ("13:00", "14:00", time(15, 0), False),
    ("09:00", "09:00", time(9, 0), False),
])
def test_quiet_hours(start, end, now, expected):
    assert in_quiet_hours(Settings(quiet_enabled=True, quiet_start=start, quiet_end=end), now) is expected
    assert in_quiet_hours(Settings(quiet_enabled=False, quiet_start=start, quiet_end=end), now) is False
