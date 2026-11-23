import { describe, expect, it } from 'vitest'
import type { DigestChannel, Sponsored } from '../net'
import { digestBody, digestFooter, digestHeader, digestPages, digestRow, doneMessage, formatCount, sponsoredBody } from './digest'
import { LINE_UNITS, textWidth } from './text'

const ad: Sponsored = { randomId: 'r1', label: 'Sponsored', title: 'Try Foo', text: 'Foo is great.', button: 'Open', sponsorInfo: 'Foo Ltd', additionalInfo: '' }
const ch = (id: string, over: Partial<DigestChannel> = {}): DigestChannel => ({
  id, title: id, newCount: 4, recent: false, maxId: 99, sponsored: null,
  top: [
    { id: 1, text: 'First post headline\nsecond line ignored', views: 6100, reactions: 76 },
    { id: 2, text: 'Another one', views: 950, reactions: 3 },
  ],
  ...over,
})
const fits = (body: string) => {
  const lines = body.split('\n')
  expect(lines.length).toBeLessThanOrEqual(7)
  for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(LINE_UNITS)
}

describe('formatCount', () => {
  it('shortens big numbers', () => {
    expect([0, 950, 1000, 6100, 6149, 12_400, 999_999, 1_200_000, 15_300_000].map(formatCount)).toEqual(['0', '950', '1k', '6.1k', '6.1k', '12k', '999k', '1.2M', '15M'])
  })
})

describe('digestPages', () => {
  it('puts each sponsored page right after its channel and numbers channel pages', () => {
    const pages = digestPages([ch('news', { sponsored: ad }), ch('tech'), ch('empty', { top: [], recent: true, maxId: null, sponsored: { ...ad, randomId: 'r2' } })])
    expect(pages.map(p => `${p.kind}:${p.channel.id}`)).toEqual(['channel:news', 'sponsored:news', 'channel:tech', 'channel:empty', 'sponsored:empty'])
    expect(pages[2]).toMatchObject({ n: 2, m: 3 })
  })
})

describe('done', () => {
  it('only on a channel page with new posts and a maxId', () => {
    const [news, sponsored] = digestPages([ch('news', { sponsored: ad })])
    expect(doneMessage(news)).toEqual({ type: 'digest_done', channelId: 'news', maxId: 99 })
    expect(doneMessage(sponsored)).toBeNull()
    expect(doneMessage(digestPages([ch('x', { recent: true })])[0])).toBeNull()
    expect(doneMessage(digestPages([ch('x', { maxId: null })])[0])).toBeNull()
  })

  it('footer offers done only when done is possible', () => {
    const [news, sponsored] = digestPages([ch('news', { sponsored: ad })])
    expect(digestFooter(news)).toBe('tap done (mark read) · ▼ next · 2x back')
    expect(digestFooter(digestPages([ch('x', { recent: true })])[0])).toBe('▼ next · 2x back')
    expect(digestFooter(sponsored)).toBe('menu: Sponsor info · ▼ next')
  })
})

describe('page text', () => {
  it('header says new or latest 24 h, with position', () => {
    const pages = digestPages([ch('Crypto News'), ch('Tech', { recent: true })])
    expect(digestHeader(pages[0])).toBe('Digest · Crypto News · 4 new  1/2')
    expect(digestHeader(pages[1])).toBe('Digest · Tech · latest 24 h  2/2')
    expect(digestHeader(digestPages([ch('News', { sponsored: { ...ad, label: 'Recommended' } })])[1])).toBe('News · Recommended')
  })

  it('body: numbered first lines with counts, always fitting', () => {
    expect(digestBody(ch('x'))).toBe('1 First post headline\n   6.1k views · 76 reactions\n2 Another one\n   950 views · 3 reactions')
    const long = 'W'.repeat(80)
    const body = digestBody(ch('x', { top: [1, 2, 3, 4].map(id => ({ id, text: long, views: 1, reactions: 1 })) }))
    fits(body)
    expect(body.split('\n')).toHaveLength(6)
  })

  it('says when a channel had no posts', () => {
    expect(digestBody(ch('x', { top: [], recent: true }))).toBe('No posts in the last 24 h')
  })

  it('sponsored body: title, text cut to fit, then the button as plain text', () => {
    const body = sponsoredBody({ ...ad, text: 'Long ad text. '.repeat(40) })
    fits(body)
    const lines = body.split('\n')
    expect(lines[0]).toBe('Try Foo')
    expect(lines.at(-1)).toBe('[Open]')
    expect(lines.at(-2)?.endsWith('…')).toBe(true)
  })
})

describe('digestRow', () => {
  it('counts picked channels', () => {
    expect(digestRow([{ id: '1', title: 'a', kind: 'channel', unread: 0 }, { id: '2', title: 'b', kind: 'user', unread: 1 }])).toBe('Digest · 1 channel')
    expect(digestRow([{ id: '2', title: 'b', kind: 'user', unread: 1 }])).toBeNull()
  })
})
