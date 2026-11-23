import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, ClientMsg, InboxChat } from '../net'
import type { State } from '../state'
import { Glasses } from '.'
import type { Page, ScreenManager } from './manager'

const chat = (id: string, unread: number): InboxChat => ({ id, title: id, kind: 'user', unread })
const card = (id: string): Card => ({
  chat: { id, title: id, kind: 'user' },
  msgs: [{ id: 7, sender: 'Dana', time: '14:01', text: 'hi', mine: false }],
  replyTo: { id: 7, sender: 'Dana', text: 'hi' },
  suggestions: ['Yes'],
  newCount: 1,
  earlier: 0,
})
const state = (chats: InboxChat[]): State => ({
  token: 't',
  base: 'http://x',
  link: 'online',
  inbox: { chats, totals: { unread: chats.reduce((s, c) => s + c.unread, 0), chats: chats.length } },
  notice: '',
})

function setup(chats = [chat('a', 1), chat('b', 2)]) {
  const pages: Page[] = []
  const texts: [string, string][] = []
  const sent: ClientMsg[] = []
  let pageId: string | null = null
  const screens = {
    get pageId() {
      return pageId
    },
    show: (p: Page) => {
      pages.push(p)
      pageId = p.id
    },
    setText: (name: string, content: string) => texts.push([name, content]),
    exit: vi.fn(),
  } as unknown as ScreenManager
  const g = new Glasses(screens, m => (sent.push(m), true))
  g.render(state(chats))
  return { g, pages, texts, sent, page: () => pages[pages.length - 1] }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Glasses', () => {
  it('opens a chat from the Inbox and shows its card when it arrives', () => {
    const { g, sent, texts, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 1 })
    expect(sent.at(-1)).toEqual({ type: 'open_chat', chatId: 'b' })
    expect(texts.at(-1)).toEqual(['hdr', 'Opening b…'])
    g.onCard(card('a')) // not the one asked for
    expect(page().id).toBe('inbox')
    g.onCard(card('b'))
    expect(page().id).toBe('card')
  })

  it('ignores taps while a chat is opening, so a card marked read is not dropped', () => {
    const { g, sent } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.input({ kind: 'LIST_SELECT', index: 1 })
    expect(sent.filter(m => m.type === 'open_chat')).toHaveLength(1)
  })

  it('shows a server error instead of waiting forever', () => {
    const { g, texts } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onError('That chat is not picked')
    expect(texts.at(-1)).toEqual(['hdr', 'That chat is not picked'])
    vi.advanceTimersByTime(3000)
    expect(texts.at(-1)?.[1]).toContain('TapBack')
  })

  it('drops a tap that trails a double-tap', () => {
    const { g, sent } = setup()
    g.input({ kind: 'DOUBLE' })
    g.input({ kind: 'LIST_SELECT', index: 0 })
    expect(sent).toEqual([])
    vi.advanceTimersByTime(300)
    g.input({ kind: 'LIST_SELECT', index: 0 })
    expect(sent).toHaveLength(1)
  })

  it('goes card → replies → sending, and undo returns to the replies', () => {
    const { g, sent, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'CLICK' })
    expect(page().id).toBe('replies')
    expect(page().menu).toBeUndefined()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    expect(page().id).toBe('sending')
    vi.advanceTimersByTime(1000)
    g.input({ kind: 'FG_ENTER' })
    vi.advanceTimersByTime(5000)
    expect(sent.some(m => m.type === 'send')).toBe(false)
    expect(page().id).toBe('replies')
  })

  it('sends after the window and moves on to the next unread chat', () => {
    const { g, sent, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'CLICK' })
    g.input({ kind: 'LIST_SELECT', index: 0 })
    vi.advanceTimersByTime(2000)
    const send = sent.at(-1)
    expect(send).toMatchObject({ type: 'send', chatId: 'a', replyTo: 7, text: 'Yes' })
    g.onSent({ clientMsgId: (send as { clientMsgId: string }).clientMsgId, ok: true, at: '14:02' })
    expect(page().id).toBe('sending')
    vi.advanceTimersByTime(1000)
    expect(sent.at(-1)).toEqual({ type: 'open_chat', chatId: 'b' })
  })

  it('sends a reaction as a reaction, not as text', () => {
    const { g, sent } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard({ ...card('a'), suggestions: ['Yes', 'React: thumbs up'] })
    g.input({ kind: 'CLICK' })
    g.input({ kind: 'LIST_SELECT', index: 1 })
    vi.advanceTimersByTime(2000)
    const send = sent.at(-1) as Record<string, unknown>
    expect(send).toMatchObject({ type: 'send', chatId: 'a', replyTo: 7, reaction: '👍' })
    expect('text' in send).toBe(false)
  })

  it('swipes to the next chat and back to the Inbox at the end', () => {
    const { g, sent, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 1 })
    g.onCard(card('b'))
    g.input({ kind: 'SWIPE_DOWN' })
    expect(page().id).toBe('inbox')
    expect(sent.at(-1)).toEqual({ type: 'open_inbox' })
  })

  it('mutes, then rebuilds the Inbox once the filtered inbox arrives', () => {
    const { g, sent, pages } = setup([chat('a', 1)])
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'MENU', itemId: 2 })
    expect(sent).toContainEqual({ type: 'mute', chatId: 'a', minutes: 60 })
    const before = pages.length
    g.render(state([])) // server's inbox without the muted chat
    expect(pages.length).toBe(before + 1)
    expect(pages.at(-1)?.texts.find(t => t.name === 'body')?.content).toContain('No chats picked')
  })

  it('double-tap on the card goes back to the Inbox', () => {
    const { g, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'DOUBLE' })
    expect(page().id).toBe('inbox')
  })
})
