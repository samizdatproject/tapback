import { describe, expect, it } from 'vitest'
import type { InboxChat } from '../net'
import { mergeOrder, neighbour, position } from './nav'

const c = (id: string, unread: number): InboxChat => ({ id, title: id, kind: 'user', unread })
const order = ['acme', 'alice', 'news', 'ops']

describe('neighbour', () => {
  it('walks the captured order even after the server re-sorts read chats to the end', () => {
    // Acme was opened, so it is read and now last in the latest inbox.
    const latest = [c('alice', 1), c('news', 37), c('ops', 0), c('acme', 0)]
    expect(neighbour(order, latest, 'acme', 1)?.id).toBe('alice')
    expect(neighbour(order, latest, 'acme', -1)).toBeNull()
  })

  it('skips chats without unread', () => {
    const latest = [c('acme', 0), c('alice', 0), c('news', 5), c('ops', 0)]
    expect(neighbour(order, latest, 'acme', 1)?.id).toBe('news')
    expect(neighbour(order, latest, 'news', -1)).toBeNull()
    expect(neighbour(order, latest, 'news', 1)).toBeNull()
  })

  it('goes back to the previous unread chat', () => {
    const latest = [c('acme', 2), c('alice', 0), c('news', 5)]
    expect(neighbour(order, latest, 'news', -1)?.id).toBe('acme')
  })

  it('works after the current chat was muted away', () => {
    const latest = [c('alice', 1), c('news', 2)]
    expect(neighbour(order, latest, 'acme', 1)?.id).toBe('alice')
  })

  it('reaches chats that appeared after the Inbox was left', () => {
    const latest = [c('acme', 0), c('fresh', 1)]
    expect(neighbour(order, latest, 'acme', 1)?.id).toBe('fresh')
    expect(mergeOrder(['a'], [c('b', 0), c('a', 0)])).toEqual(['a', 'b'])
  })
})

describe('position', () => {
  it('counts the current chat and the unread ones', () => {
    const latest = [c('alice', 1), c('news', 37), c('acme', 0)]
    expect(position(order, latest, 'acme')).toEqual({ n: 1, m: 3 })
    expect(position(order, latest, 'news')).toEqual({ n: 2, m: 2 }) // read chats drop out
  })

  it('never steps onto a channel (channels are read in the digest)', () => {
    const latest: InboxChat[] = [c('acme', 0), { id: 'alice', title: 'news', kind: 'channel', unread: 9 }, c('news', 2)]
    expect(neighbour(order, latest, 'acme', 1)?.id).toBe('news')
    expect(position(order, latest, 'acme')).toEqual({ n: 1, m: 2 })
  })
})
