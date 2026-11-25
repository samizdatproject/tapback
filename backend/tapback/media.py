"""Short, explicit labels for media on the lens: "[voice 0:14]", "[photo] caption", "[file: a.pdf]".

Only Telegram's own metadata is read (type, duration, file name, poll question). Voice notes
are never transcribed: no Telegram data goes through speech-to-text or any other model.
"""

from __future__ import annotations

from telethon.tl.types import (
    Document,
    DocumentAttributeAnimated,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeSticker,
    DocumentAttributeVideo,
    MessageMediaContact,
    MessageMediaDocument,
    MessageMediaGeo,
    MessageMediaGeoLive,
    MessageMediaPhoto,
    MessageMediaPoll,
    MessageMediaVenue,
)

from .cards import cut

NAME_MAX = 40


def duration(seconds: float | int | None) -> str:
    s = max(0, round(seconds or 0))
    return f"{s // 60}:{s % 60:02d}"


def _document_label(doc) -> str:
    if not isinstance(doc, Document):
        return "[file]"
    attrs = doc.attributes or []

    def find(kind):
        return next((a for a in attrs if isinstance(a, kind)), None)

    audio, video = find(DocumentAttributeAudio), find(DocumentAttributeVideo)
    # Order matters: video stickers, round videos and GIFs also carry a video attribute.
    if find(DocumentAttributeSticker):
        return "[sticker]"
    if audio and audio.voice:
        return f"[voice {duration(audio.duration)}]"
    if video and video.round_message:
        return f"[video message {duration(video.duration)}]"
    if find(DocumentAttributeAnimated):
        return "[GIF]"
    if video:
        return f"[video {duration(video.duration)}]"
    if audio:
        return f"[audio {duration(audio.duration)}]"
    name = find(DocumentAttributeFilename)
    return f"[file: {cut(name.file_name, NAME_MAX)}]" if name and name.file_name.strip() else "[file]"


def media_label(msg) -> str | None:
    """The label for the message's media, or None for plain text (link previews included)."""
    media = getattr(msg, "media", None)
    if isinstance(media, MessageMediaPhoto):
        return "[photo]"
    if isinstance(media, MessageMediaDocument):
        return _document_label(media.document)
    if isinstance(media, MessageMediaPoll):
        q = media.poll.question
        q = getattr(q, "text", q) or ""  # TextWithEntities in newer layers, str in older ones
        return f"[poll: {cut(q, NAME_MAX)}]" if q.strip() else "[poll]"
    if isinstance(media, (MessageMediaGeo, MessageMediaGeoLive, MessageMediaVenue)):
        return "[location]"
    if isinstance(media, MessageMediaContact):
        return "[contact]"
    return None


def message_text(msg) -> str:
    """Card text: the media label, then the caption or text when there is one."""
    label, text = media_label(msg), (msg.message or "").strip()
    return " ".join(p for p in (label, text) if p) or "[message]"
