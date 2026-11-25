import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, ClientMsg, DigestChannel, InboxChat } from '../net'
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
  readMaxId: 9,
})
const beginId = (sent: ClientMsg[]) => {
  const begins = sent.filter(m => m.type === 'audio_begin')
  return (begins[begins.length - 1] as { id: string }).id
}
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
      return Promise.resolve(true)
    },
    setText: (name: string, content: string) => texts.push([name, content]),
    exit: vi.fn(),
  } as unknown as ScreenManager
  const audio: Uint8Array[] = []
  const micCalls: boolean[] = []
  const g = new Glasses(screens, {
    send: m => (sent.push(m), true),
    sendAudio: pcm => (audio.push(pcm), true),
    mic: async on => (micCalls.push(on), true),
  })
  g.render(state(chats))
  return { g, pages, texts, sent, audio, micCalls, page: () => pages[pages.length - 1] }
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
    g.onError({ code: 'not_picked', human: 'That chat is not picked', for: 'open_chat', chatId: 'a' })
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

  it('"Later" marks the chat unread, says so, then moves on to the next chat', () => {
    const { g, sent, texts, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    expect(page().menu?.[0]).toEqual({ name: 'Later: keep unread', id: 7 })
    g.input({ kind: 'MENU', itemId: 7 })
    expect(sent.at(-1)).toEqual({ type: 'later', chatId: 'a' })
    expect(texts.at(-1)).toEqual(['hdr', 'Kept unread for later ●'])
    vi.advanceTimersByTime(1000)
    expect(sent.at(-1)).toEqual({ type: 'open_chat', chatId: 'b' })
  })

  it('"Later" goes back to the Inbox in quiet hours', () => {
    const { g, sent, page } = setup([chat('a', 1), chat('b', 2)])
    const quiet = state([chat('a', 1), chat('b', 2)])
    g.render({ ...quiet, inbox: { ...quiet.inbox!, quiet: { active: true, until: '08:00' } } })
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'MENU', itemId: 7 })
    vi.advanceTimersByTime(1000)
    expect(page().id).toBe('inbox')
    expect(sent.filter(m => m.type === 'open_chat')).toHaveLength(1)
  })

  it('a failed "Later" stays on the card and says why', () => {
    const { g, sent, texts, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'MENU', itemId: 7 })
    g.onError({ code: 'failed', human: "Telegram didn't accept it. Try again.", for: 'later', chatId: 'a' })
    expect(texts.at(-1)).toEqual(['hdr', "Couldn't keep it for later: Telegram didn't accept it. Try again."])
    vi.advanceTimersByTime(1000)
    expect(page().id).toBe('card')
    expect(sent.filter(m => m.type === 'open_chat')).toHaveLength(1)
  })

  it('opens a breakthrough chat from the Inbox like a picked one', () => {
    const { g, sent, pages } = setup([{ ...chat('dana', 1), breakthrough: true }, chat('b', 2)])
    expect(pages.at(-1)?.list?.items[0]).toBe('+ dana · 1')
    g.input({ kind: 'LIST_SELECT', index: 0 })
    expect(sent.at(-1)).toEqual({ type: 'open_chat', chatId: 'dana' })
  })

  it('double-tap on the card goes back to the Inbox', () => {
    const { g, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'DOUBLE' })
    expect(page().id).toBe('inbox')
  })

  it('a failed mute does not cancel the next chat that is opening', () => {
    const { g, page } = setup()
    g.input({ kind: 'LIST_SELECT', index: 0 })
    g.onCard(card('a'))
    g.input({ kind: 'MENU', itemId: 2 }) // mute a, then open b
    g.onError({ code: 'bad_request', human: "Can't do that", for: 'mute', chatId: 'a' })
    g.onCard(card('b'))
    expect(page().id).toBe('card')
    expect(page().texts[0].content).toContain('b')
  })
})

describe('Glasses dictation', () => {
  async function onCard() {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    t.g.onCard(card('a'))
    return t
  }
  const flush = () => vi.advanceTimersByTimeAsync(0)

  it('hold to talk: mic on, frames only while listening, release sends audio_end', async () => {
    const t = await onCard()
    t.g.input({ kind: 'LONG_START' })
    await flush()
    expect(t.micCalls).toEqual([true])
    expect(t.sent.at(-1)).toMatchObject({ type: 'audio_begin' })
    t.g.input({ kind: 'AUDIO', pcm: new Uint8Array(4) })
    t.g.input({ kind: 'LONG_END' })
    t.g.input({ kind: 'AUDIO', pcm: new Uint8Array(4) })
    expect(t.audio).toHaveLength(1)
    expect(t.micCalls).toEqual([true, false])
    expect(t.sent.at(-1)).toEqual({ type: 'audio_end' })
    t.g.onStt({ id: beginId(t.sent), text: 'On my way', human: '' })
    t.g.input({ kind: 'CLICK' })
    expect(t.page().id).toBe('sending')
    vi.advanceTimersByTime(2000)
    expect(t.sent.at(-1)).toMatchObject({ type: 'send', chatId: 'a', replyTo: 7, text: 'On my way' })
  })

  it('double-tap while listening cancels and turns the mic off', async () => {
    const t = await onCard()
    t.g.input({ kind: 'LONG_START' })
    await flush()
    t.g.input({ kind: 'DOUBLE' })
    expect(t.micCalls).toEqual([true, false])
    expect(t.sent.at(-1)).toEqual({ type: 'audio_cancel' })
  })

  it('an audio error from the server turns the mic off', async () => {
    const t = await onCard()
    t.g.input({ kind: 'LONG_START' })
    await flush()
    t.g.onError({ code: 'failed', human: 'Recording failed', for: 'audio_begin' })
    expect(t.micCalls).toEqual([true, false])
    expect(t.texts.at(-1)?.[1]).toContain('Recording failed')
  })

  it('opening the menu while listening cancels and turns the mic off', async () => {
    const t = await onCard()
    t.g.input({ kind: 'LONG_START' })
    await flush()
    t.g.input({ kind: 'FG_ENTER' })
    expect(t.micCalls).toEqual([true, false])
    expect(t.sent.at(-1)).toEqual({ type: 'audio_cancel' })
    vi.advanceTimersByTime(1000)
    expect(t.page().id).toBe('card')
  })

  it('losing the connection or unpairing turns the mic off', async () => {
    const t = await onCard()
    t.g.input({ kind: 'LONG_START' })
    await flush()
    t.g.render({ ...state([chat('a', 0), chat('b', 2)]), link: 'offline' })
    expect(t.micCalls).toEqual([true, false])
    const u = await onCard()
    u.g.input({ kind: 'LONG_START' })
    await flush()
    u.g.render({ ...state([]), token: null })
    expect(u.micCalls).toEqual([true, false])
  })

  it('tap route from Quick replies: tap Dictate… to start, tap to stop', async () => {
    const t = await onCard()
    t.g.input({ kind: 'CLICK' }) // replies: Yes, Dictate…
    t.g.input({ kind: 'LIST_SELECT', index: 1 })
    await flush()
    expect(t.micCalls).toEqual([true])
    t.g.input({ kind: 'CLICK' })
    expect(t.micCalls).toEqual([true, false])
    t.g.onStt({ id: beginId(t.sent), text: '', human: "Didn't catch that" })
    expect(t.texts.at(-1)?.[1]).toContain('tap retry')
    t.g.input({ kind: 'DOUBLE' })
    expect(t.page().id).toBe('replies')
  })
})

const ch = (id: string, over: Partial<DigestChannel> = {}): DigestChannel => ({
  id, title: id, newCount: 4, recent: false, maxId: 50, sponsored: null,
  top: [{ id: 1, text: 'post', views: 10, reactions: 1 }],
  ...over,
})
const ad = { randomId: 'r1', label: 'Sponsored', title: 'Ad', text: 'Buy', button: 'Open', sponsorInfo: 'Foo Ltd', additionalInfo: '' }

describe('Glasses digest', () => {

  function open(channels: DigestChannel[]) {
    const t = setup([chat('a', 1), { id: 'c1', title: 'News', kind: 'channel', unread: 4 }])
    t.g.input({ kind: 'LIST_SELECT', index: 2 }) // the Digest row after the two chats
    expect(t.sent.at(-1)).toEqual({ type: 'digest_open' })
    t.g.onDigest(channels)
    return t
  }
  const flush = () => vi.advanceTimersByTimeAsync(0)

  it('shows a Digest row on the Inbox', () => {
    const t = setup([chat('a', 1), { id: 'c1', title: 'News', kind: 'channel', unread: 4 }])
    expect(t.page().list?.items.at(-1)).toBe('Digest · 1 channel')
  })

  it('done sends digest_done once, then moves on', async () => {
    const t = open([ch('c1'), ch('c2', { recent: true, maxId: null })])
    t.g.input({ kind: 'CLICK' })
    expect(t.sent.at(-1)).toEqual({ type: 'digest_done', channelId: 'c1', maxId: 50 })
    expect(t.texts.at(-1)).toEqual(['ftr', 'Marked read ●'])
    vi.advanceTimersByTime(800)
    expect(t.page().texts[0].content).toContain('c2')
    const before = t.sent.length
    t.g.input({ kind: 'CLICK' }) // recent page: tap does nothing
    expect(t.sent.length).toBe(before)
  })

  it('reports a sponsored view once, after the page is drawn', async () => {
    const t = open([ch('c1', { sponsored: ad })])
    t.g.input({ kind: 'SWIPE_DOWN' })
    await flush()
    t.g.input({ kind: 'SWIPE_UP' })
    await flush()
    t.g.input({ kind: 'SWIPE_DOWN' })
    await flush()
    t.g.input({ kind: 'MENU', itemId: 5 }) // Refresh digest: same ad again
    t.g.onDigest([ch('c1', { sponsored: ad })])
    t.g.input({ kind: 'SWIPE_DOWN' })
    await flush()
    expect(t.sent.filter(m => m.type === 'sponsored_viewed')).toEqual([{ type: 'sponsored_viewed', randomId: 'r1' }])
    t.g.input({ kind: 'MENU', itemId: 4 })
    expect(t.page().id).toBe('sponsor-info')
    t.g.input({ kind: 'DOUBLE' })
    expect(t.page().id).toBe('digest')
  })

  it('past the last page goes back to the Inbox', () => {
    const t = open([ch('c1')])
    t.g.input({ kind: 'SWIPE_DOWN' })
    expect(t.page().id).toBe('inbox')
  })

  it('a channel row opens the digest at that channel', () => {
    const t = setup([chat('a', 1), { id: 'c2', title: 'Tech', kind: 'channel', unread: 0 }])
    t.g.input({ kind: 'LIST_SELECT', index: 1 })
    expect(t.sent.at(-1)).toEqual({ type: 'digest_open' })
    t.g.onDigest([ch('c1', { sponsored: ad }), ch('c2')])
    expect(t.page().id).toBe('digest')
    expect(t.page().texts[0].content).toBe('Digest · c2 · 4 new  2/2') // pages: c1, ad, c2
  })
})

describe('Glasses card_shown (read only once seen)', () => {
  it('is sent once, after the card page is drawn', async () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    t.g.onCard(card('a'))
    expect(t.sent.some(m => m.type === 'card_shown')).toBe(false) // not before the draw resolves
    await vi.advanceTimersByTimeAsync(0)
    t.g.input({ kind: 'CLICK' }) // to replies
    t.g.input({ kind: 'DOUBLE' }) // back to the same card
    await vi.advanceTimersByTimeAsync(0)
    expect(t.sent.filter(m => m.type === 'card_shown')).toEqual([{ type: 'card_shown', chatId: 'a', maxId: 9 }])
  })

  it('is never sent for a card that was dropped or left before it was drawn', async () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    vi.advanceTimersByTime(8000) // open timed out
    t.g.onCard(card('a')) // arrives late: ignored
    t.g.input({ kind: 'LIST_SELECT', index: 1 })
    t.g.onCard(card('b'))
    t.g.input({ kind: 'DOUBLE' }) // left before the draw resolved
    await vi.advanceTimersByTimeAsync(0)
    expect(t.sent.some(m => m.type === 'card_shown')).toBe(false)
  })

  it('is not sent when there is nothing to mark read', async () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    t.g.onCard({ ...card('a'), readMaxId: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(t.sent.some(m => m.type === 'card_shown')).toBe(false)
  })
})

describe('Glasses leaving mid-dictation', () => {
  it('unpairing while listening shows the Intro and never redraws the old card', async () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    t.g.onCard(card('a'))
    t.g.input({ kind: 'LONG_START' })
    await vi.advanceTimersByTimeAsync(0)
    t.g.render({ ...state([]), token: null })
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.pages.map(p => p.id).slice(-2)).toEqual(['dictate', 'intro'])
    expect(t.micCalls).toEqual([true, false])
  })

  it('EXIT while listening turns the mic off and schedules nothing', async () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    t.g.onCard(card('a'))
    t.g.input({ kind: 'LONG_START' })
    await vi.advanceTimersByTimeAsync(0)
    const before = t.pages.length
    t.g.input({ kind: 'EXIT' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(t.pages.length).toBe(before)
    expect(t.micCalls).toEqual([true, false])
  })

  it('double-tap while a chat is opening cancels the open instead of exiting', () => {
    const t = setup()
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    vi.advanceTimersByTime(400)
    t.g.input({ kind: 'DOUBLE' })
    t.g.onCard(card('a')) // late answer: ignored, so never shown and never marked read
    expect(t.page().id).toBe('inbox')
    expect(t.texts.at(-1)?.[1]).toContain('TapBack')
  })

  it('quiet hours: after a send it goes back to the Inbox instead of opening the next chat', () => {
    const chats = [chat('a', 1), chat('b', 2)]
    const t = setup(chats)
    t.g.render({ ...state(chats), inbox: { ...state(chats).inbox!, quiet: { active: true, until: '08:00' } } })
    expect(t.texts.at(-2)).toEqual(['hdr', 'Quiet until 08:00 · 3 new'])
    t.g.input({ kind: 'LIST_SELECT', index: 0 }) // manual opening still works
    t.g.onCard(card('a'))
    t.g.input({ kind: 'CLICK' })
    t.g.input({ kind: 'LIST_SELECT', index: 0 })
    vi.advanceTimersByTime(2000)
    const send = t.sent.at(-1) as { clientMsgId: string }
    t.g.onSent({ clientMsgId: send.clientMsgId, ok: true, at: '14:02' })
    expect(t.texts.at(-1)).toEqual(['msg', 'Sent ● 14:02 · back to inbox (quiet hours)'])
    vi.advanceTimersByTime(1000)
    expect(t.page().id).toBe('inbox')
    expect(t.sent.filter(m => m.type === 'open_chat')).toHaveLength(1)
  })
})
