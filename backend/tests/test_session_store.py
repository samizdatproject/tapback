import os
import stat

import pytest
from cryptography.exceptions import InvalidTag

from tapback import session_store


def test_roundtrip_and_permissions(tmp_path):
    sess, key = tmp_path / "s" / "session.enc", tmp_path / "s" / "session.key"
    session_store.save(sess, key, "1BVtsOK-secret-session")
    assert session_store.load(sess, key) == "1BVtsOK-secret-session"
    assert b"secret-session" not in sess.read_bytes()
    for p in (sess, key):
        assert stat.S_IMODE(os.stat(p).st_mode) == 0o600


def test_tampered_session_is_rejected(tmp_path):
    sess, key = tmp_path / "session.enc", tmp_path / "session.key"
    session_store.save(sess, key, "abc")
    blob = bytearray(sess.read_bytes())
    blob[-1] ^= 1
    sess.write_bytes(bytes(blob))
    with pytest.raises(InvalidTag):
        session_store.load(sess, key)


def test_missing_key_does_not_create_one(tmp_path):
    sess, key = tmp_path / "session.enc", tmp_path / "session.key"
    session_store.save(sess, key, "abc")
    key.unlink()
    with pytest.raises(SystemExit):
        session_store.load(sess, key)
    assert not key.exists()


def test_wipe(tmp_path):
    sess, key = tmp_path / "session.enc", tmp_path / "session.key"
    session_store.save(sess, key, "abc")
    session_store.wipe(sess, key)
    assert not sess.exists() and not key.exists()
