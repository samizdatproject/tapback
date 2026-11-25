import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

from telethon import utils
from telethon.tl.custom.message import Message
from telethon.tl.functions.messages import GetPeerDialogsRequest, MarkDialogUnreadRequest, TranslateTextRequest
from telethon.tl.custom.dialog import Dialog
from telethon.tl.types import (
    Channel,
    Chat,
    ChatPhotoEmpty,
    Document,
    DocumentAttributeAudio,
    InputDialogPeer,
    InputPeerUser,
    MessageMediaDocument,
    MessageMediaPhoto,
    PeerChannel,
    PeerChat,
    PeerNotifySettings,
    PeerUser,
    TextWithEntities,
    User,
)
from telethon.tl.types import Dialog as RawDialog
from telethon.tl.types.messages import TranslateResult

from tapback.settings import Settings
from tapback.tg import Telegram, breaks_through, chat_row

NOW = datetime(2026, 11, 25, tzinfo=timezone.utc)
ON = Settings(vip=["dana"], breakthrough=True)

DANA = User(id=42, first_name="Dana", username="dana_k", access_hash=1)
ALICE = User(id=43, first_name="Alice", access_hash=1)
GROUP = Chat(id=7, title="Ops", photo=ChatPhotoEmpty(), participants_count=5, date=NOW, version=1)
SUPER = Channel(id=8, title="Team", photo=ChatPhotoEmpty(), date=NOW, megagroup=True, access_hash=1)
NEWS = Channel(id=9, title="News", photo=ChatPhotoEmpty(), date=NOW, broadcast=True, access_hash=1)
PEERS = {42: PeerUser(42), 43: PeerUser(43), 7: PeerChat(7), 8: PeerChannel(8), 9: PeerChannel(9)}


def raw(entity, unread=1, mentions=0, mark=None, folder=None):
    return RawDialog(peer=PEERS[entity.id], top_message=1, read_inbox_max_id=0, read_outbox_max_id=0,
                     unread_count=unread, unread_mentions_count=mentions, unread_reactions_count=0,
                     unread_poll_votes_count=0, notify_settings=PeerNotifySettings(), unread_mark=mark,
                     folder_id=folder)


def dialog(entity, **kw):
    r = raw(entity, **kw)
    return Dialog(None, r, {utils.get_peer_id(r.peer): entity}, None)


def test_breakthrough_is_off_unless_opted_in():
    assert not breaks_through(DANA, raw(DANA), Settings(vip=["dana"]))
    assert not breaks_through(DANA, raw(DANA), None)
    assert breaks_through(DANA, raw(DANA), ON)


def test_breakthrough_vip_private_chats_on_name_or_username():
    assert breaks_through(DANA, raw(DANA), Settings(vip=["dana_k"], breakthrough=True))
    assert not breaks_through(ALICE, raw(ALICE), ON)  # not a VIP
    assert not breaks_through(DANA, raw(DANA, unread=0), ON)  # nothing unread
    assert not breaks_through(DANA, raw(DANA, folder=1), ON)  # archived


def test_breakthrough_vip_kept_for_later_stays_but_a_marked_group_does_not():
    assert breaks_through(DANA, raw(DANA, unread=0, mark=True), ON)  # "Later" on a VIP keeps it on the glasses
    assert not breaks_through(GROUP, raw(GROUP, unread=0, mentions=1, mark=True), ON)


def test_breakthrough_groups_only_when_they_mention_me_never_channels():
    assert breaks_through(GROUP, raw(GROUP, unread=3, mentions=1), ON)
    assert breaks_through(SUPER, raw(SUPER, unread=3, mentions=2), ON)
    assert not breaks_through(SUPER, raw(SUPER, unread=3), ON)
    assert not breaks_through(NEWS, raw(NEWS, unread=3, mentions=1), ON)


def test_chat_row_reads_later_and_breakthrough():
    row = chat_row(dialog(DANA, mark=True), set(), ON)
    assert row["later"] is True and row["breakthrough"] is True and row["picked"] is False
    picked = chat_row(dialog(DANA), {"42"}, ON)
    assert picked["breakthrough"] is False and picked["later"] is False
    assert chat_row(dialog(GROUP, unread=0, mark=True), set(), ON)["later"] is True


# --- Telegram glue, with a stub client (no network) ---------------------------------------------

class StubClient:
    def __init__(self, entities, dialog=None):
        self.entities, self.dialog, self.requests = entities, dialog, []
        self.translations: list[str] = []  # what Telegram's translateText answers, in request order

    async def get_entity(self, chat_id):
        if chat_id not in self.entities:
            raise ValueError("unknown")
        return self.entities[chat_id]

    async def get_input_entity(self, entity):
        return utils.get_input_peer(self.entities[entity] if isinstance(entity, int) else entity)

    async def __call__(self, request):
        self.requests.append(request)
        if isinstance(request, GetPeerDialogsRequest):
            return SimpleNamespace(dialogs=[self.dialog] if self.dialog else [])
        if isinstance(request, TranslateTextRequest):
            return TranslateResult(result=[TextWithEntities(text=t, entities=[]) for t in self.translations])
        return True


def tg_with(client):
    tg = Telegram.__new__(Telegram)
    tg.client = client
    return tg


def test_mark_unread_uses_telegrams_mark_dialog_unread():
    client = StubClient({42: DANA})
    tg = tg_with(client)
    asyncio.run(tg.mark_unread("42", True))
    asyncio.run(tg.mark_unread("42", False))
    first, second = client.requests
    assert isinstance(first, MarkDialogUnreadRequest) and isinstance(first.peer, InputDialogPeer)
    assert isinstance(first.peer.peer, InputPeerUser) and first.peer.peer.user_id == 42
    assert first.unread is True and second.unread is False


def test_breakthrough_recheck_reads_the_live_dialog():
    tg = tg_with(StubClient({42: DANA}, raw(DANA, unread=2)))
    assert asyncio.run(tg.breakthrough("42", ON)) is True
    assert asyncio.run(tg_with(StubClient({42: DANA}, raw(DANA, unread=0))).breakthrough("42", ON)) is False
    assert asyncio.run(tg_with(StubClient({})).breakthrough("42", ON)) is False  # unknown chat


def test_card_reports_the_later_mark_and_labels_media():
    voice = MessageMediaDocument(document=Document(
        id=1, access_hash=1, file_reference=b"", date=NOW, mime_type="audio/ogg", size=10, dc_id=2,
        attributes=[DocumentAttributeAudio(duration=14, voice=True)]))
    client = StubClient({42: DANA}, raw(DANA, unread=1, mark=True))

    async def get_messages(entity, limit):
        return [Message(id=5, peer_id=PeerUser(42), date=NOW, message="", media=voice)]

    client.get_messages = get_messages
    card = asyncio.run(tg_with(client).card("42"))
    assert card["later"] is True and card["msgs"][0]["text"] == "[voice 0:14]"


VOICE = MessageMediaDocument(document=Document(
    id=1, access_hash=1, file_reference=b"", date=NOW, mime_type="audio/ogg", size=10, dc_id=2,
    attributes=[DocumentAttributeAudio(duration=14, voice=True)]))


def history_client(messages):
    client = StubClient({42: DANA})
    client.fetched = []

    async def get_messages(entity, ids):
        client.fetched.append((entity, list(ids)))
        by_id = {m.id: m for m in messages}
        return [by_id.get(i) for i in ids]

    client.get_messages = get_messages
    return client


def test_translate_asks_telegram_by_message_id_and_skips_media_only():
    client = history_client([
        Message(id=5, peer_id=PeerUser(42), date=NOW, message="Hello friend"),
        Message(id=6, peer_id=PeerUser(42), date=NOW, message="", media=VOICE),  # nothing to translate
        Message(id=7, peer_id=PeerUser(42), date=NOW, message="Nice view", media=MessageMediaPhoto()),
    ])
    client.translations = ["Hola  👋 amigo", "Bonita vista"]
    out = asyncio.run(tg_with(client).translate("42", [5, 6, 7, 99], "es"))
    (request,) = client.requests
    assert isinstance(request, TranslateTextRequest) and request.to_lang == "es"
    assert isinstance(request.peer, InputPeerUser) and request.peer.user_id == 42
    assert request.id == [5, 7] and request.text is None  # Telegram reads the messages itself
    assert client.fetched[0][1] == [5, 6, 7, 99]
    assert out == {5: "Hola amigo", 7: "[photo] Bonita vista"}  # emoji stripped, caption keeps its label


def test_translate_cuts_long_text_and_never_calls_telegram_without_text():
    client = history_client([Message(id=5, peer_id=PeerUser(42), date=NOW, message="x")])
    client.translations = ["word " * 100]
    text = asyncio.run(tg_with(client).translate("42", [5], "en"))[5]
    assert len(text) <= 280 and text.endswith("…")
    media_only = history_client([Message(id=6, peer_id=PeerUser(42), date=NOW, message="", media=VOICE)])
    assert asyncio.run(tg_with(media_only).translate("42", [6], "en")) == {}
    assert media_only.requests == []
