from datetime import datetime, timezone

from telethon.tl.custom.message import Message
from telethon.tl.types import (
    Document,
    DocumentAttributeAnimated,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeSticker,
    DocumentAttributeVideo,
    GeoPoint,
    InputStickerSetEmpty,
    MessageMediaContact,
    MessageMediaDocument,
    MessageMediaGeo,
    MessageMediaPhoto,
    MessageMediaPoll,
    MessageMediaVenue,
    MessageMediaWebPage,
    Photo,
    Poll,
    PollResults,
    PeerUser,
    TextWithEntities,
    WebPage,
)

from tapback.cards import build_card
from tapback.media import duration, media_label, message_text

NOW = datetime(2026, 11, 25, tzinfo=timezone.utc)
PHOTO = Photo(id=1, access_hash=1, file_reference=b"", date=NOW, sizes=[], dc_id=2)


def msg(media=None, text=""):
    return Message(id=1, peer_id=PeerUser(42), date=NOW, message=text, media=media)


def doc(*attributes):
    return MessageMediaDocument(document=Document(id=1, access_hash=1, file_reference=b"", date=NOW,
                                                  mime_type="application/octet-stream", size=10, dc_id=2,
                                                  attributes=list(attributes)))


def test_duration_is_minutes_and_seconds():
    assert duration(14) == "0:14" and duration(9.4) == "0:09" and duration(75) == "1:15" and duration(None) == "0:00"


def test_voice_and_video_notes_show_type_and_length():
    assert message_text(msg(doc(DocumentAttributeAudio(duration=14, voice=True)))) == "[voice 0:14]"
    round_video = doc(DocumentAttributeVideo(duration=9.0, w=240, h=240, round_message=True))
    assert message_text(msg(round_video)) == "[video message 0:09]"
    assert message_text(msg(doc(DocumentAttributeVideo(duration=30.2, w=1280, h=720)))) == "[video 0:30]"
    assert message_text(msg(doc(DocumentAttributeAudio(duration=200, title="Song")))) == "[audio 3:20]"


def test_photo_label_comes_before_the_caption():
    assert message_text(msg(MessageMediaPhoto(photo=PHOTO))) == "[photo]"
    assert message_text(msg(MessageMediaPhoto(photo=PHOTO), "  Where are you? ")) == "[photo] Where are you?"
    assert message_text(msg(doc(DocumentAttributeVideo(duration=5, w=1, h=1)), "look")) == "[video 0:05] look"


def test_files_stickers_and_gifs():
    assert message_text(msg(doc(DocumentAttributeFilename(file_name="Q3 report.pdf")))) == "[file: Q3 report.pdf]"
    long_name = msg(doc(DocumentAttributeFilename(file_name="a-very-long-file-name-" * 4 + ".pdf")))
    assert len(media_label(long_name)) <= len("[file: ]") + 40
    assert message_text(msg(doc())) == "[file]"
    video_sticker = doc(DocumentAttributeVideo(duration=3, w=512, h=512),
                        DocumentAttributeSticker(alt="", stickerset=InputStickerSetEmpty()))
    assert message_text(msg(video_sticker)) == "[sticker]"
    gif = doc(DocumentAttributeVideo(duration=2, w=320, h=240), DocumentAttributeAnimated())
    assert message_text(msg(gif)) == "[GIF]"


def test_polls_locations_and_contacts():
    poll = Poll(id=1, question=TextWithEntities(text="Lunch at 1?", entities=[]), answers=[], hash=0)
    assert message_text(msg(MessageMediaPoll(poll=poll, results=PollResults()))) == "[poll: Lunch at 1?]"
    assert message_text(msg(MessageMediaGeo(geo=GeoPoint(long=1.0, lat=2.0, access_hash=0)))) == "[location]"
    venue = MessageMediaVenue(geo=GeoPoint(long=1.0, lat=2.0, access_hash=0), title="Cafe", address="",
                              provider="", venue_id="", venue_type="")
    assert message_text(msg(venue)) == "[location]"
    contact = MessageMediaContact(phone_number="+100", first_name="Dana", last_name="", vcard="", user_id=7)
    assert message_text(msg(contact)) == "[contact]"


def test_plain_text_and_link_previews_have_no_label():
    assert message_text(msg(text="hello")) == "hello"
    preview = MessageMediaWebPage(webpage=WebPage(id=1, url="https://x.org", display_url="x.org", hash=0, photo=PHOTO))
    assert message_text(msg(preview, "see https://x.org")) == "see https://x.org"
    assert message_text(msg()) == "[message]"


def test_card_text_drops_emoji_from_captions():
    text = message_text(msg(MessageMediaPhoto(photo=PHOTO), "🔥 launch day 🚀"))
    m = {"id": 1, "sender": "Dana", "time": "14:00", "text": text, "mine": False, "mentions_me": False}
    card = build_card({"id": "42", "title": "Dana", "kind": "user"}, [m], unread=1)
    assert card["msgs"][0]["text"] == "[photo] launch day"
