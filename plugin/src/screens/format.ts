import type { Inbox, InboxChat, LinkStatus, Totals } from '../net'

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

/**
 * "+" marks a chat that isn't picked but broke through (plain ASCII: the G2 font
 * drops many glyphs), then the flag; "later" marks a chat kept unread for later.
 */
export function inboxRow(chat: InboxChat): string {
  const marks = (chat.breakthrough ? '+' : '') + (chat.flag ?? '')
  const prefix = marks ? `${marks} ` : ''
  const count = chat.unread > 0 ? ` · ${chat.unread > 999 ? '999+' : chat.unread}` : ''
  const suffix = count + (chat.later ? ' · later' : '')
  const title = chat.title.replace(/\s+/g, ' ').trim() || 'Untitled chat'
  const extra = prefix + suffix
  const room = { chars: ROW_MAX_CHARS - Array.from(extra).length, bytes: ROW_MAX_BYTES - bytes(extra) }
  return prefix + fit(title, room.chars, room.bytes) + suffix
}

export function inboxRows(chats: InboxChat[]): string[] {
  return chats.slice(0, LIST_MAX_ITEMS).map(inboxRow)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** `later`: chats kept unread for later, so "all caught up" is never shown while some wait. */
export function headerText(totals: Totals | null, quiet?: { active: boolean; until: string }, later = 0): string {
  if (quiet?.active) {
    const head = quiet.until ? `Quiet until ${quiet.until}` : 'Quiet hours'
    return totals && totals.unread > 0 ? `${head} · ${totals.unread} new` : head
  }
  if (!totals) return 'TapBack'
  if (totals.unread <= 0) return later > 0 ? `TapBack · ${later} for later` : 'TapBack · all caught up'
  return `TapBack · ${totals.unread} new in ${plural(totals.chats, 'chat')}` + (later > 0 ? ` · ${later} later` : '')
}

export function inboxHeader(inbox: Inbox | null): string {
  return headerText(inbox?.totals ?? null, inbox?.quiet, inbox?.chats.filter(c => c.later).length ?? 0)
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
