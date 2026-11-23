import { describe, expect, it } from 'vitest'
import { backoffDelay, normaliseBase, parseServerMsg, wsUrl } from './net'

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(n => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
  })

  it('never goes below the base', () => {
    expect(backoffDelay(-3)).toBe(1000)
  })
})

describe('urls', () => {
  it('derives the WebSocket URL', () => {
    expect(wsUrl('http://localhost:8787')).toBe('ws://localhost:8787/ws')
    expect(wsUrl('https://tb.example.org')).toBe('wss://tb.example.org/ws')
  })

  it('normalises a typed backend URL', () => {
    expect(normaliseBase(' http://localhost:8787/ ')).toBe('http://localhost:8787')
    expect(() => normaliseBase('ftp://x')).toThrow()
    expect(() => normaliseBase('not a url')).toThrow()
  })
})

describe('parseServerMsg', () => {
  it('parses an inbox and coerces ids to strings', () => {
    const msg = parseServerMsg(
      JSON.stringify({
        type: 'inbox',
        chats: [{ id: 42, title: 'Acme Work', kind: 'group', unread: 2 }],
        totals: { unread: 2, chats: 1 },
      }),
    )
    expect(msg).toEqual({
      type: 'inbox',
      chats: [{ id: '42', title: 'Acme Work', kind: 'group', unread: 2 }],
      totals: { unread: 2, chats: 1 },
    })
  })

  it('parses an error', () => {
    expect(parseServerMsg('{"type":"error","code":"auth","human":"Bad token"}')).toEqual({
      type: 'error',
      code: 'auth',
      human: 'Bad token',
    })
  })

  it('ignores unknown types, bad JSON and binary frames', () => {
    expect(parseServerMsg('{"type":"later"}')).toBeNull()
    expect(parseServerMsg('nope')).toBeNull()
    expect(parseServerMsg(new ArrayBuffer(4))).toBeNull()
  })
})
