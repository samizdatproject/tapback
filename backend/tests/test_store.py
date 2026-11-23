from tapback.store import PAIR_MAX_ATTEMPTS, PAIR_TTL_S, Store


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_picked_roundtrip_keeps_order(tmp_path):
    s = Store(tmp_path / "db.sqlite")
    assert s.picked() == []
    s.set_picked(["-100", "42", "7"])
    assert s.picked() == ["-100", "42", "7"]
    s.set_picked(["7"])
    assert s.picked() == ["7"]


def test_pairing_code_is_single_use(tmp_path):
    s = Store(tmp_path / "db.sqlite")
    code = s.new_pairing_code()
    assert len(code) == 6 and code.isdigit()
    token = s.redeem_pairing_code(code)
    assert token and s.is_device(token)
    assert s.redeem_pairing_code(code) is None


def test_pairing_code_expires(tmp_path):
    clock = Clock()
    s = Store(tmp_path / "db.sqlite", clock=clock)
    code = s.new_pairing_code()
    clock.t += PAIR_TTL_S + 1
    assert s.redeem_pairing_code(code) is None


def test_pairing_locks_after_too_many_wrong_codes(tmp_path):
    s = Store(tmp_path / "db.sqlite")
    code = s.new_pairing_code()
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(PAIR_MAX_ATTEMPTS):
        assert s.redeem_pairing_code(wrong) is None
    assert s.redeem_pairing_code(code) is None


def test_tokens_are_not_stored_in_clear(tmp_path):
    path = tmp_path / "db.sqlite"
    s = Store(path)
    token = s.redeem_pairing_code(s.new_pairing_code())
    assert token.encode() not in path.read_bytes()
    assert not s.is_device(None) and not s.is_device("nope")
    s.forget_devices()
    assert not s.is_device(token)
