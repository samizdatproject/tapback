# TapBack

[![test](https://github.com/samizdatproject/tapback/actions/workflows/test.yml/badge.svg)](https://github.com/samizdatproject/tapback/actions/workflows/test.yml)

**Telegram triage for Even G2 smart glasses. An unofficial Telegram client that uses the Telegram API.**

TapBack shows only the Telegram chats you pick, one card at a time, on the G2 display. You answer with two taps from rule-based reply suggestions, or hold to dictate a reply. A 30-second digest shows the top posts of the channels you follow.

Built for the [Heads Up: Even Realities hackathon](https://dorahacks.io/hackathon/even-realities/detail) (Nov 23–29, 2026), track 01 · Messaging & News.

> Work in progress during the build week. This README grows with the code.

## How it works

```
G2 glasses ──BLE── Even Realities app (WebView: TapBack plugin, Vite + TypeScript + Even Hub SDK)
                        │  HTTP + WebSocket to your own backend (pairing code, device token)
                        ▼
               TapBack backend (Python: FastAPI + Telethon), on your own machine
                 ├─ Telegram user client (your own api_id): picked chats only
                 ├─ deterministic reply rules and digest ranking (no AI on Telegram data)
                 └─ whisper.cpp server on the same machine for dictation
```

- **Pick what matters.** On the phone screen you tick the chats and channels that matter. Nothing else ever reaches the glasses. Archived chats are never offered.
- **Glance, tap, tap.** A new message from a picked chat shows as a card. Opening it marks it read, as Telegram's rules require (no "ghost mode"). One tap opens reply suggestions; a second tap sends after a 2-second undo window.
- **Hold to talk.** Dictation goes to whisper.cpp on your own machine. You see the transcript and confirm before anything is sent.
- **Digest.** The top 3 new posts per picked channel, ranked by views, reactions and forwards, shown verbatim. Telegram's sponsored messages are shown where Telegram returns them.

## Privacy and Telegram's terms

- **No Telegram data goes to any AI service.** Reply suggestions come from published regex rules ([`backend/tapback/rules.py`](backend/tapback/rules.py)); the digest ranks by metadata and shows each post's own first line.
- **Self-hosted.** The backend runs on your machine. The Telegram session is stored only encrypted (AES-256-GCM), with the key in a separate file.
- **No message storage.** Message text stays in memory; the database holds only picked chat ids, hashed device tokens and mute timers. Logs never contain message text.
- **Read receipts honoured, every send undoable.** Replies go only to chats you picked, at most 10 a minute.
- **Sponsored messages** are fetched as Telegram requires, cached for 5 minutes and reported as viewed only when shown. The glasses can't open links, so the button label is shown as plain text.
- TapBack is not affiliated with Telegram. It uses its own api_id, as Telegram's API terms require.

## Setup (developer preview)

Requirements: Python 3.11+, Node 22.13+, a Telegram api_id/api_hash from [my.telegram.org](https://my.telegram.org), and [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for dictation.

```bash
# 1. backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
mkdir -p -m 700 ~/.config/tapback        # secrets live outside the repo
cat > ~/.config/tapback/tapback.env <<'EOF'
TG_API_ID=123456
TG_API_HASH=your_api_hash
EOF
export TAPBACK_ENV=~/.config/tapback/tapback.env
.venv/bin/python -m tapback login   # phone, code, 2FA in your terminal
.venv/bin/python -m tapback serve   # prints a 6-digit pairing code

# 2. speech-to-text (optional)
whisper-server -m models/ggml-base.en.bin --host 127.0.0.1 --port 8080

# 3. plugin
cd ../plugin && npm install && npm run dev
# then run the Even Hub simulator against http://localhost:5173 (see plugin/README.md)
```

Pair on the phone screen with the code the backend printed, pick your chats, and press Save.
Or start everything at once with `scripts/run-local.sh`.

### On real glasses

In the simulator the plugin reaches the backend at `localhost`. On a phone, `localhost` is the phone, so the backend needs an HTTPS address the phone can reach. **Don't expose it over plain HTTP**: the device token, messages and audio would cross the network unencrypted. Put it behind TLS, for example `tailscale serve 8787` on a tailnet your phone is on, or a reverse proxy such as Caddy on a VPS, and add that `https://` and `wss://` origin to the `network` whitelist in `plugin/app.json`.

The device token is as powerful as the backend itself, so pair only your own phone. **Log out & wipe** on the phone screen ends the Telegram session (`auth.logOut`), deletes the encrypted session and forgets every paired device.

## What existed before Nov 23

Before the hackathon (Nov 23, 08:00 UTC) there were research and design notes only: screen sketches, the reply rules and the architecture. We ran a throwaway copy of the official `minimal` template to learn how the simulator delivers taps and swipes, then deleted it. We also registered a Telegram api_id and built whisper.cpp locally. **No TapBack code existed. All code in this repository was written from Nov 23, 2026.**

**Third-party code:** Even Hub SDK and templates (MIT), Telethon, FastAPI, uvicorn, cryptography, httpx, whisper.cpp, Vite, TypeScript and vitest, all under their own licenses.

**How it was built:** with AI coding assistance (Claude), disclosed here. TapBack itself sends no Telegram data to any AI service.

## License

MIT
