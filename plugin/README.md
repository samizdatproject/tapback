# TapBack plugin

The Even G2 side of TapBack: a Vite + TypeScript web app that runs in the Even
Realities App WebView. It draws the glasses screens and also serves the phone
screen (the companion WebView), where you pair with your TapBack backend and pick
chats.

## Run it

Requires Node 22.13 or later.

```bash
npm install
npm run dev          # http://localhost:5173
```

In a second terminal, start the simulator. It is not a dependency of this
package; install `@evenrealities/evenhub-simulator` in any folder and run its
entry point (npm does not always link its binary):

```bash
npm install @evenrealities/evenhub-simulator
node node_modules/@evenrealities/evenhub-simulator/bin/index.js --automation-port 9898 http://localhost:5173
```

- The glasses window shows the Intro screen until you pair.
- The webview window is the phone screen. Enter the backend URL (default
  `http://localhost:8787`) and the 6-digit code the backend prints, then pick
  chats and press Save.
- Restart the simulator between runs. In one simulator session
  `createStartUpPageContainer` only succeeds once, and reloading the page does
  not reset it. The plugin logs the result to the console.
- With `--automation-port`, `GET /api/screenshot/glasses` returns a PNG of the
  display, and `POST /api/input {"action":"click"|"double_click"|"up"|"down"|"context_menu"}`
  simulates input.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 |
| `npm run build` | Type-check, then build to `dist/` |
| `npm test` | Unit tests (vitest) |
| `npm run pack` | Build and package `tapback.ehpk` with the Even Hub CLI |

## Layout

```
src/
  main.ts            wiring: state, backend link, input handling
  bridge.ts          Even bridge + normalise(event) → Input
  net.ts             backend contract: HTTP helpers, WebSocket with backoff reconnect
  storage.ts         token and backend URL (Even App storage + localStorage)
  state.ts           tiny observable store
  screens/
    manager.ts       the only code that creates, rebuilds, or updates glasses pages
    format.ts        pure text formatting and the inbox rebuild rule
    intro.ts         Intro / unpaired page
    inbox.ts         Inbox page (header, chat list, footer, "Refresh" menu)
    card.ts          Card page; fits messages into the lines that are on screen
    replies.ts       Quick replies page
    sending.ts       Sending page and the undo-window state machine
    dictate.ts       dictation state machine (mic, PCM frames, transcript) and its pages
    digest.ts        digest pages: channels, sponsored pages, sponsor info
    nav.ts           next / previous chat with unread
    text.ts          width model for the proportional glasses font
    index.ts         the glasses state machine: inputs and server replies → pages
  companion/         phone screen (plain DOM)
```

## Glasses behaviour

- **Intro** (until paired): the app name, the "Unofficial Telegram client" notice,
  and how to pair. Double-tap opens the system exit dialog.
- **Inbox** (root): the header shows live totals (`TapBack · 3 new in 2 chats`).
  The list shows the picked chats with unread counts, and the footer shows
  connection state (`Offline · retrying…`). Double-tap opens the system exit
  dialog.
- The list is never redrawn while you are looking at it, because a redraw would
  move the highlight. New counts update the header. The footer then says the list
  has changed, and **Refresh** in the glasses menu redraws it. Saving a new pick
  on the phone, or coming back from a card, also redraws it.
- **Inbox rows** for chats that mention you or match an urgent word start with
  `!`, and chats with a message from a VIP start with `★` (the server lists them
  first). During quiet hours the header reads `Quiet until 08:00 · 3 new`. A channel row opens the Digest at that
  channel.
- **Card**: tap a chat to open its newest messages. The chat is marked read in
  Telegram only once the card is actually on the glasses. The body always fits the screen so swipes reach the app. Swipe ▼/▲
  goes to the next or previous chat with unread (channels are skipped), tap opens Quick replies, and
  double-tap goes back to the Inbox. The glasses menu offers Mute chat 1h and
  Snooze 30 min.
- **Quick replies**: suggestions from the backend. Tap one to send it, or
  double-tap to go back to the card.
- **Dictate**: hold (long press) on a card or Quick replies and speak; release to
  stop. Or tap "Dictate…" to start and tap again to stop. Audio streams only to
  your own backend for transcription (15 s max). The preview sends with a tap
  (through the same undo window) or is discarded with a double-tap. Double-tap or
  opening the glasses menu while listening cancels, and the microphone is turned
  off whenever dictation ends or the page changes.
- **Digest**: the last row of the Inbox. One page per picked channel with up to
  three top posts (first line verbatim, views and reactions). "tap done" marks
  the channel read; pages showing the latest 24 h (nothing new) have no done.
  A channel's sponsored message follows on its own page; its button is shown as
  text only, and "Sponsor info" in the glasses menu shows who is behind it.
- **Sending**: 2 s undo window (double-tap, or opening the glasses menu, cancels).
  Then `Sent ●` and the next chat with unread. A failure shows the reason with
  `tap retry`; nothing is resent without a tap, and a retry reuses the message id
  so the server never sends it twice.

## Phone screen

Pairing, the chat picker, **Triage** (VIP senders get `★`, urgent words get `!`,
and quiet hours, during which the glasses show counts only and never move on by
themselves), **Unpair** (forget this device's token), **Log out &
wipe** (asks for a second tap within 5 s, then signs the server out of Telegram
and deletes its session), and a short privacy summary. If the server revokes the
device, the plugin returns to pairing.
