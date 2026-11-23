import { describe, expect, it } from 'vitest'
import type { InboxChat } from '../net'
import {
  INTRO_TEXT,
  LIST_MAX_ITEMS,
  ROW_MAX_BYTES,
  ROW_MAX_CHARS,
  fit,
  footerText,
  headerText,
  inboxRow,
  inboxRows,
  planInbox,
} from './format'

const chat = (title: string, unread = 0): InboxChat => ({ id: title, title, kind: 'group', unread })
const bytes = (s: string) => new TextEncoder().encode(s).length

describe('inbox rows', () => {
  it('shows the unread count after the title', () => {
    expect(inboxRow(chat('Acme Work', 2))).toBe('Acme Work · 2')
    expect(inboxRow(chat('Alice'))).toBe('Alice')
  })

  it('truncates long titles but keeps the count', () => {
    const row = inboxRow(chat('A very long group title that keeps going and going and going', 12))
    expect(row.endsWith('… · 12')).toBe(true)
    expect(Array.from(row).length).toBeLessThanOrEqual(ROW_MAX_CHARS)
    expect(bytes(row)).toBeLessThanOrEqual(ROW_MAX_BYTES)
  })

  it('respects the byte cap for non-Latin titles and never splits a code point', () => {
    const row = inboxRow(chat('Рабочая группа по проекту и всё такое прочее', 3))
    expect(bytes(row)).toBeLessThanOrEqual(ROW_MAX_BYTES)
    expect(row).not.toContain('�')
    const emoji = fit('🎉'.repeat(30), 55, 63)
    expect(bytes(emoji)).toBeLessThanOrEqual(63)
    expect(Array.from(emoji).slice(0, -1).every(c => c === '🎉')).toBe(true)
  })

  it('collapses whitespace and names untitled chats', () => {
    expect(inboxRow(chat('  Line\none  ', 1))).toBe('Line one · 1')
    expect(inboxRow(chat('   '))).toBe('Untitled chat')
  })

  it('caps big counts and the number of rows', () => {
    expect(inboxRow(chat('Busy', 12345))).toBe('Busy · 999+')
    expect(inboxRows(Array.from({ length: 30 }, (_, i) => chat(`c${i}`)))).toHaveLength(LIST_MAX_ITEMS)
  })
})

describe('header and footer', () => {
  it('summarises totals', () => {
    expect(headerText({ unread: 3, chats: 2 })).toBe('TapBack · 3 new in 2 chats')
    expect(headerText({ unread: 1, chats: 1 })).toBe('TapBack · 1 new in 1 chat')
    expect(headerText({ unread: 0, chats: 0 })).toBe('TapBack · all caught up')
    expect(headerText(null)).toBe('TapBack')
  })

  it('says when offline', () => {
    expect(footerText('offline', false)).toBe('Offline · retrying…')
    expect(footerText('online', true)).toContain('Refresh')
    expect(footerText('online', false)).toBe('Double-tap to exit')
  })

  it('keeps the intro wording the Telegram API terms ask for', () => {
    expect(INTRO_TEXT.split('\n').slice(0, 2)).toEqual([
      'TapBack',
      'Unofficial Telegram client · uses the Telegram API',
    ])
    expect(INTRO_TEXT).not.toContain('✓')
  })
})

describe('planInbox', () => {
  const list = { body: 'list' as const, rows: ['A · 1', 'B'] }

  it('builds the first page and body changes', () => {
    expect(planInbox(null, null, true)).toBe('rebuild')
    expect(planInbox({ body: 'connecting', rows: [] }, ['A'], false)).toBe('rebuild')
    expect(planInbox(list, [], false)).toBe('rebuild')
  })

  it('never rebuilds a focused list unless the user re-entered', () => {
    expect(planInbox(list, ['A · 2', 'B'], false)).toBe('stale')
    expect(planInbox(list, ['A · 2', 'B'], true)).toBe('rebuild')
  })

  it('does nothing when nothing changed', () => {
    expect(planInbox(list, ['A · 1', 'B'], true)).toBe('same')
    expect(planInbox({ body: 'empty', rows: [] }, [], false)).toBe('same')
  })
})
