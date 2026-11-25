import { afterEach, describe, expect, it, vi } from 'vitest'
import { Link, backoffDelay, normaliseBase, parseServerMsg, wsUrl } from './net'

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
  it('keeps the later and breakthrough marks only when they are true', () => {
    const msg = parseServerMsg(
      JSON.stringify({
        type: 'inbox',
        chats: [
          { id: 1, title: 'Dana', kind: 'user', unread: 0, later: true, breakthrough: false },
          { id: 2, title: 'Ops', kind: 'group', unread: 2, flag: '!', later: false, breakthrough: true },
        ],
        totals: { unread: 2, chats: 1 },
      }),
    )
    expect(msg?.type === 'inbox' && msg.chats).toEqual([
      { id: '1', title: 'Dana', kind: 'user', unread: 0, later: true },
      { id: '2', title: 'Ops', kind: 'group', unread: 2, flag: '!', breakthrough: true },
    ])
  })

  it('parses the result of "later"', () => {
    expect(parseServerMsg(JSON.stringify({ type: 'later', chatId: 42, ok: true }))).toEqual({
      type: 'later',
      chatId: '42',
      ok: true,
    })
    expect(parseServerMsg(JSON.stringify({ type: 'later', ok: true }))).toBeNull()
  })

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

describe('parse day-5 fields', () => {
  it('reads the flag, readMaxId and stt id', () => {
    const inbox = parseServerMsg('{"type":"inbox","chats":[{"id":1,"title":"A","kind":"group","unread":2,"flag":"!"},{"id":2,"title":"B","kind":"user","unread":0,"flag":""}],"totals":{}}')
    expect(inbox?.type === 'inbox' && inbox.chats.map(c => c.flag)).toEqual(['!', undefined])
    const card = parseServerMsg('{"type":"card","chat":{"id":1,"title":"A","kind":"user"},"msgs":[],"readMaxId":42}')
    expect(card?.type === 'card' && card.readMaxId).toBe(42)
    const vip = parseServerMsg('{"type":"inbox","chats":[{"id":1,"title":"A","kind":"group","unread":1,"flag":"★"}],"totals":{},"quiet":{"active":true,"until":"08:00"}}')
    expect(vip?.type === 'inbox' && [vip.chats[0].flag, vip.quiet]).toEqual(['★', { active: true, until: '08:00' }])
    expect(parseServerMsg('{"type":"stt","id":"d1","text":" hi ","human":""}')).toEqual({ type: 'stt', id: 'd1', text: 'hi', human: '' })
  })
})

describe('Link and a revoked device', () => {
  class FakeSocket {
    static OPEN = 1
    static last: FakeSocket
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onclose: ((ev: { code: number }) => void) | null = null
    sent: unknown[] = []
    constructor(readonly url: string) {
      FakeSocket.last = this
    }
    send(d: unknown) {
      this.sent.push(d)
    }
    close() {}
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('close code 4401 stops retrying and reports unpaired', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    const events: string[] = []
    const link = new Link('ws://x/ws', 't', { message: () => {}, status: s => events.push(s), unpaired: () => events.push('unpaired') })
    link.start()
    const first = FakeSocket.last
    first.onclose?.({ code: 4401 })
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual(['connecting', 'unpaired'])
    expect(FakeSocket.last).toBe(first) // no reconnect
  })

  it('other closes keep retrying', () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    const link = new Link('ws://x/ws', 't', { message: () => {}, status: () => {}, unpaired: () => {} })
    link.start()
    const first = FakeSocket.last
    first.onclose?.({ code: 1006 })
    vi.advanceTimersByTime(1000)
    expect(FakeSocket.last).not.toBe(first)
    link.stop()
  })
})
