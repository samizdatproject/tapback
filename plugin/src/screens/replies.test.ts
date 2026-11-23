import { describe, expect, it } from 'vitest'
import type { Card } from '../net'
import { buildReplies, repliesHeader } from './replies'
import { LINE_UNITS, textWidth } from './text'

describe('buildReplies', () => {
  it('maps suggestions, the reaction and the dictate item', () => {
    expect(buildReplies(['Works for me', 'Yes', 'React: thumbs up'])).toEqual([
      { kind: 'text', label: 'Works for me', text: 'Works for me' },
      { kind: 'text', label: 'Yes', text: 'Yes' },
      { kind: 'reaction', label: 'React: thumbs up', reaction: '👍' },
      { kind: 'dictate', label: 'Dictate… (soon)' },
    ])
  })

  it('drops blanks and duplicates and cuts long labels but sends the full text', () => {
    const longText = 'Sorry, I am in a meeting right now and will get back to you later today'
    const replies = buildReplies(['  ', 'Yes', 'yes', longText])
    expect(replies.map(r => r.kind)).toEqual(['text', 'text', 'dictate'])
    const last = replies[1]
    expect(last.kind === 'text' && last.text).toBe(longText)
    expect(last.label.endsWith('…')).toBe(true)
  })

  it('still offers dictation with no suggestions', () => {
    expect(buildReplies([])).toEqual([{ kind: 'dictate', label: 'Dictate… (soon)' }])
  })
})

describe('repliesHeader', () => {
  const base: Card = { chat: { id: '2', title: 'Alice', kind: 'user' }, msgs: [], replyTo: null, suggestions: [], newCount: 1, earlier: 0 }

  it('quotes the message being answered, cut to one line', () => {
    const h = repliesHeader({ ...base, replyTo: { id: 5, sender: 'Dana', text: 'Can you join the investor call at 3? Need you for the token-unlock slide.' } })
    expect(h.startsWith('Re Dana: "Can you join the investor')).toBe(true)
    expect(h.endsWith('…"')).toBe(true)
    expect(textWidth(h)).toBeLessThanOrEqual(LINE_UNITS)
  })

  it('names the chat when there is nothing to reply to', () => {
    expect(repliesHeader(base)).toBe('To Alice')
  })
})
