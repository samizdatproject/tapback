import type { InboxChat } from '../net'

// The server lists unread chats first, so a chat jumps to the end once read.
// Card navigation therefore walks the order captured when the user left the
// Inbox (plus chats that appeared since), filtered by the latest unread counts.

/** The captured order with any chats new in `latest` appended. */
export function mergeOrder(order: string[], latest: InboxChat[]): string[] {
  const known = new Set(order)
  return [...order, ...latest.map(c => c.id).filter(id => !known.has(id))]
}

/** Chats a swipe can reach: the current one plus every chat that still has unread. */
function stops(order: string[], latest: InboxChat[], currentId: string): string[] {
  const unread = new Set(latest.filter(c => c.unread > 0).map(c => c.id))
  return mergeOrder(order, latest).filter(id => id === currentId || unread.has(id))
}

/** Next (dir 1) or previous (dir -1) chat with unread, or null at either end. */
export function neighbour(
  order: string[],
  latest: InboxChat[],
  currentId: string,
  dir: 1 | -1,
): InboxChat | null {
  const ids = stops(order, latest, currentId)
  const i = ids.indexOf(currentId)
  const id = i === -1 ? (dir === 1 ? ids[0] : undefined) : ids[i + dir]
  return latest.find(c => c.id === id) ?? null
}

/** 1-based position of the current chat among the reachable ones, e.g. 2/3. */
export function position(order: string[], latest: InboxChat[], currentId: string): { n: number; m: number } {
  const ids = stops(order, latest, currentId)
  const i = ids.indexOf(currentId)
  return i === -1 ? { n: 1, m: ids.length + 1 } : { n: i + 1, m: ids.length }
}
