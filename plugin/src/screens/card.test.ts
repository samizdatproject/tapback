import { describe, expect, it } from 'vitest'
import type { Card, CardMsg } from '../net'
import { CARD_BODY_LINES, cardBody, cardHeader, cardPage, translatedMsgs } from './card'
import { LINE_UNITS, textWidth } from './text'

const msg = (id: number, sender: string, text: string, mine = false): CardMsg => ({ id, sender, time: '14:01', text, mine })
const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit.'

const card = (over: Partial<Card> = {}): Card => ({
  chat: { id: '1', title: 'Acme Work', kind: 'group' },
  msgs: [],
  replyTo: null,
  suggestions: [],
  newCount: 3,
  earlier: 0,
  readMaxId: null,
  ...over,
})

function checkFits(body: string, budget = CARD_BODY_LINES) {
  const lines = body.split('\n')
  expect(lines.length).toBeLessThanOrEqual(budget)
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(LINE_UNITS)
}

describe('cardBody', () => {
  it('shows each message as a sender line plus its text', () => {
    const body = cardBody([msg(1, 'Dana', 'Can you join at 3?'), msg(2, 'Lee', '+1, 15 min max')])
    expect(body).toBe('Dana 14:01\nCan you join at 3?\nLee 14:01\n+1, 15 min max')
  })

  it('labels my own messages "You"', () => {
    expect(cardBody([msg(1, 'Me', 'on my way', true)])).toBe('You 14:01\non my way')
  })

  it('cuts one long message to the line budget with an ellipsis', () => {
    const body = cardBody([msg(1, 'Dana', long + ' ' + long)])
    checkFits(body)
    expect(body.split('\n')).toHaveLength(CARD_BODY_LINES)
    expect(body.endsWith('…')).toBe(true)
  })

  it('keeps the newest message whole and cuts or drops older ones', () => {
    const body = cardBody([msg(1, 'Old', long), msg(2, 'Mid', 'short one'), msg(3, 'New', 'Can you join the investor call at 3? Need you for the token-unlock slide.')])
    checkFits(body)
    const lines = body.split('\n')
    expect(lines.slice(-3)).toEqual(['New 14:01', 'Can you join the investor call at 3? Need you for the', 'token-unlock slide.'])
    expect(lines).toContain('Mid 14:01')
    expect(lines[0]).toBe('Old 14:01')
    expect(lines[1].endsWith('…')).toBe(true)
  })

  it('never leaves a sender line without text', () => {
    const body = cardBody([msg(1, 'Old', 'x'), msg(2, 'New', long)], 7)
    checkFits(body)
    expect(body.split('\n')[0]).toBe('New 14:01')
  })

  it('fits three messages with line breaks and empty text', () => {
    const body = cardBody([msg(1, 'A', 'one\n\n\ntwo'), msg(2, 'B', ''), msg(3, 'C', 'three')])
    checkFits(body)
    expect(body).toBe('A 14:01\none\ntwo\nB 14:01\n(no text)\nC 14:01\nthree')
  })

  it('says so when there is nothing', () => {
    expect(cardBody([])).toBe('No new messages to show.')
  })
})

describe('cardHeader', () => {
  it('shows new count, earlier messages and position', () => {
    expect(cardHeader(card(), { n: 2, m: 3 })).toBe('Acme Work · 3 new  2/3')
    expect(cardHeader(card({ earlier: 9 }), null)).toBe('Acme Work · 3 new · +9 earlier on phone')
    expect(cardHeader(card({ newCount: 0 }), { n: 1, m: 1 })).toBe('Acme Work')
  })

  it('cuts a long title but keeps counts and position', () => {
    const h = cardHeader(card({ chat: { id: '1', title: 'A very long group title that keeps going and going', kind: 'group' }, earlier: 12 }), { n: 1, m: 4 })
    expect(h.endsWith('… · 3 new · +12 earlier on phone  1/4')).toBe(true)
    expect(textWidth(h)).toBeLessThanOrEqual(LINE_UNITS)
  })
})

describe('translation on the card', () => {
  it('offers Translate right after Later', () => {
    expect(cardPage(card(), null).menu?.map(m => m.name)).toEqual(['Later: keep unread', 'Translate', 'Mute chat 1h', 'Snooze 30 min'])
  })

  it('says "translated" in the header and still fits the line', () => {
    expect(cardHeader(card(), { n: 2, m: 3 }, true)).toBe('Acme Work · 3 new · translated  2/3')
    const h = cardHeader(card({ chat: { id: '1', title: 'A very long group title that keeps going', kind: 'group' }, newCount: 999, earlier: 999 }), { n: 10, m: 20 }, true)
    expect(h.endsWith('… · 999 new · translated  10/20')).toBe(true)
    expect(textWidth(h)).toBeLessThanOrEqual(LINE_UNITS)
  })

  it('swaps in translated texts and keeps sender, time and untranslated messages', () => {
    const msgs = [msg(1, 'Dana', 'Hola'), msg(2, 'Lee', '[voice 0:14]')]
    const out = translatedMsgs(msgs, new Map([[1, 'Hello']]))
    expect(cardBody(out)).toBe('Dana 14:01\nHello\nLee 14:01\n[voice 0:14]')
    expect(msgs[0].text).toBe('Hola')
  })
})
