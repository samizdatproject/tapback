import type { Card } from '../net'
import { LIST_MAX_ITEMS, ROW_MAX_BYTES, ROW_MAX_CHARS, fit } from './format'
import { BODY, FOOTER, HEADER, type Page } from './manager'
import { LINE_UNITS, fitWidth } from './text'

export type Reply =
  | { kind: 'text'; label: string; text: string }
  | { kind: 'reaction'; label: string; reaction: string }
  | { kind: 'dictate'; label: string }

const REACTION_LABEL = /^react:\s*thumbs up$/i

/** Server suggestions → list items, ending with the (not yet working) dictate item. */
export function buildReplies(suggestions: string[]): Reply[] {
  const seen = new Set<string>()
  const out: Reply[] = []
  for (const raw of suggestions) {
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    const label = fit(text, ROW_MAX_CHARS, ROW_MAX_BYTES)
    out.push(REACTION_LABEL.test(text) ? { kind: 'reaction', label, reaction: '👍' } : { kind: 'text', label, text })
  }
  return [...out.slice(0, LIST_MAX_ITEMS - 1), { kind: 'dictate', label: 'Dictate… (soon)' }]
}

export function repliesHeader(card: Card): string {
  if (!card.replyTo) return fitWidth(`To ${card.chat.title.trim() || 'this chat'}`, LINE_UNITS)
  const who = card.replyTo.sender.trim() || 'them'
  const quote = card.replyTo.text.replace(/\s+/g, ' ').trim()
  const head = `Re ${who}: "`
  return fitWidth(head + quote, LINE_UNITS - 1) + '"'
}

export function repliesPage(card: Card, replies: Reply[]): Page {
  return {
    id: 'replies',
    texts: [
      { name: 'hdr', ...HEADER, content: repliesHeader(card), dim: true },
      { name: 'ftr', ...FOOTER, content: 'tap send · 2x back', dim: true },
    ],
    list: { name: 'replies', ...BODY, items: replies.map(r => r.label) },
    // No menu on this page (design rule): the OS menu would compete with list taps.
  }
}
