import type { Card, CardMsg } from '../net'
import { BODY, FOOTER, HEADER, type Page } from './manager'
import { LINE_UNITS, fitWidth, textWidth, wrapText } from './text'

export const MENU_MUTE = 2
export const MENU_SNOOZE = 3
export const MUTE_MINUTES = 60
export const SNOOZE_MINUTES = 30

/** Body lines that fit between header and footer (208 px at ~28 px a line). */
export const CARD_BODY_LINES = 7

export function cardHeader(card: Card, pos: { n: number; m: number } | null): string {
  let suffix = card.newCount > 0 ? ` · ${card.newCount} new` : ''
  if (card.earlier > 0) suffix += ` · +${card.earlier} earlier on phone`
  const where = pos && pos.m > 1 ? `  ${pos.n}/${pos.m}` : ''
  const title = card.chat.title.replace(/\s+/g, ' ').trim() || 'Untitled chat'
  return fitWidth(title, Math.max(8, LINE_UNITS - textWidth(suffix + where))) + suffix + where
}

function messageLines(m: CardMsg, units: number): string[] {
  const who = m.mine ? 'You' : m.sender.trim() || 'Someone'
  const head = fitWidth(m.time ? `${who} ${m.time}` : who, units)
  const text = wrapText(m.text.trim() || '(no text)', units).filter(l => l !== '')
  return [head, ...text]
}

/**
 * Lays out up to 3 messages in `budget` lines so the text never overflows
 * (overflowing text eats swipes). The newest message wins: it is kept whole if
 * it fits, older ones fill what is left, and whatever is cut ends in "…".
 */
export function cardBody(msgs: CardMsg[], budget = CARD_BODY_LINES, units = LINE_UNITS): string {
  if (msgs.length === 0) return 'No new messages to show.'
  const blocks: string[][] = []
  let left = budget
  for (const m of [...msgs].reverse()) {
    if (left < 2) break // a sender line alone says nothing
    const lines = messageLines(m, units)
    if (lines.length > left) {
      const kept = lines.slice(0, left)
      kept[left - 1] = fitWidth(kept[left - 1] + '…', units)
      blocks.unshift(kept)
      break
    }
    blocks.unshift(lines)
    left -= lines.length
  }
  return blocks.flat().join('\n')
}

export function cardPage(card: Card, pos: { n: number; m: number } | null): Page {
  return {
    id: 'card',
    texts: [
      { name: 'hdr', ...HEADER, content: cardHeader(card, pos), dim: true },
      { name: 'body', ...BODY, content: cardBody(card.msgs), capture: true },
      { name: 'ftr', ...FOOTER, content: 'tap reply · ▼ next · 2x back', dim: true },
    ],
    menu: [
      { name: 'Mute chat 1h', id: MENU_MUTE },
      { name: 'Snooze 30 min', id: MENU_SNOOZE },
    ],
  }
}
