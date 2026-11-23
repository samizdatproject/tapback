import type { InboxChat, LinkStatus, Totals } from '../net'

// Measured in the simulator: about 10 lines of about 55 proportional
// characters. List items are capped at 63 UTF-8 bytes by the simulator.
export const ROW_MAX_CHARS = 55
export const ROW_MAX_BYTES = 63
export const LIST_MAX_ITEMS = 20

const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).length

/** Cuts by code point so it fits both limits, ending in "…" when cut. */
export function fit(text: string, maxChars: number, maxBytes = Infinity): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars && bytes(text) <= maxBytes) return text
  const out: string[] = []
  let used = bytes('…')
  for (const ch of chars) {
    const b = bytes(ch)
    if (out.length + 2 > maxChars || used + b > maxBytes) break
    out.push(ch)
    used += b
  }
  return out.join('').trimEnd() + '…'
}

export function inboxRow(chat: InboxChat): string {
  const suffix = chat.unread > 0 ? ` · ${chat.unread > 999 ? '999+' : chat.unread}` : ''
  const title = chat.title.replace(/\s+/g, ' ').trim() || 'Untitled chat'
  const room = { chars: ROW_MAX_CHARS - Array.from(suffix).length, bytes: ROW_MAX_BYTES - bytes(suffix) }
  return fit(title, room.chars, room.bytes) + suffix
}

export function inboxRows(chats: InboxChat[]): string[] {
  return chats.slice(0, LIST_MAX_ITEMS).map(inboxRow)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function headerText(totals: Totals | null): string {
  if (!totals) return 'TapBack'
  if (totals.unread <= 0) return 'TapBack · all caught up'
  return `TapBack · ${totals.unread} new in ${plural(totals.chats, 'chat')}`
}

export function footerText(link: LinkStatus, stale: boolean): string {
  if (link === 'offline') return 'Offline · retrying…'
  if (link === 'connecting') return 'Connecting…'
  if (stale) return 'New activity · menu: Refresh'
  return 'Double-tap to exit'
}

export const INTRO_TEXT = [
  'TapBack',
  'Unofficial Telegram client · uses the Telegram API',
  '',
  'Pair on your phone screen: enter the code shown by the backend.',
  '',
  'Double-tap to exit',
].join('\n')

export const EMPTY_TEXT = 'No chats picked yet. Pick them on your phone screen.'
export const CONNECTING_TEXT = 'Connecting to your TapBack server…'

export type InboxBody = 'connecting' | 'empty' | 'list'
export interface ShownInbox {
  body: InboxBody
  rows: string[]
}

export function bodyOf(rows: string[] | null): InboxBody {
  if (rows === null) return 'connecting'
  return rows.length === 0 ? 'empty' : 'list'
}

/**
 * Decides how a new inbox reaches the glasses. A focused list must not be
 * rebuilt (focus jumps to the top), so changed rows only mark it stale unless
 * the user just (re)entered the Inbox (`entry`).
 */
export function planInbox(
  shown: ShownInbox | null,
  nextRows: string[] | null,
  entry: boolean,
): 'rebuild' | 'stale' | 'same' {
  const next = bodyOf(nextRows)
  if (!shown || shown.body !== next) return 'rebuild'
  if (next !== 'list') return 'same'
  const rows = nextRows ?? []
  const same = rows.length === shown.rows.length && rows.every((r, i) => r === shown.rows[i])
  if (same) return 'same'
  return entry ? 'rebuild' : 'stale'
}
