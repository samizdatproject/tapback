import type { ClientMsg, DigestChannel, InboxChat, Sponsored } from '../net'
import { CARD_BODY_LINES } from './card'
import { BODY, FOOTER, HEADER, type Page } from './manager'
import { LINE_UNITS, fitWidth, textWidth, wrapText } from './text'

export const MENU_SPONSOR_INFO = 4
export const MENU_REFRESH_DIGEST = 5
export const MENU_BACK_TO_INBOX = 6

export type DigestPage =
  | { kind: 'channel'; channel: DigestChannel; n: number; m: number }
  | { kind: 'sponsored'; channel: DigestChannel; ad: Sponsored }

/** One page per channel, each followed by its sponsored page if it has one. */
export function digestPages(channels: DigestChannel[]): DigestPage[] {
  return channels.flatMap((channel, i): DigestPage[] => {
    const page: DigestPage = { kind: 'channel', channel, n: i + 1, m: channels.length }
    return channel.sponsored ? [page, { kind: 'sponsored', channel, ad: channel.sponsored }] : [page]
  })
}

/** The digest_done to send for a "done" tap, or null when the page has nothing to mark read. */
export function doneMessage(page: DigestPage | undefined): ClientMsg | null {
  if (page?.kind !== 'channel' || page.channel.recent || page.channel.maxId === null) return null
  return { type: 'digest_done', channelId: page.channel.id, maxId: page.channel.maxId }
}

/** 950, 6.1k, 12k, 1.2M */
export function formatCount(n: number): string {
  const v = Math.max(0, Math.round(n))
  const short = (x: number, unit: string) => `${x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x)}${unit}`
  if (v < 1000) return String(v)
  if (v < 1_000_000) return short(v / 1000, 'k')
  return short(v / 1_000_000, 'M')
}

/** The Inbox row that opens the digest, or null without picked channels. */
export function digestRow(chats: InboxChat[]): string | null {
  const n = chats.filter(c => c.kind === 'channel').length
  return n > 0 ? `Digest · ${n} channel${n === 1 ? '' : 's'}` : null
}

export function digestHeader(page: DigestPage): string {
  const title = page.channel.title.replace(/\s+/g, ' ').trim() || 'Channel'
  if (page.kind === 'sponsored') {
    const suffix = ` · ${page.ad.label || 'Sponsored'}`
    return fitWidth(title, LINE_UNITS - textWidth(suffix)) + suffix
  }
  const what = page.channel.recent ? 'latest 24 h' : `${page.channel.newCount} new`
  const prefix = 'Digest · '
  const suffix = ` · ${what}${page.m > 1 ? `  ${page.n}/${page.m}` : ''}`
  return prefix + fitWidth(title, LINE_UNITS - textWidth(prefix + suffix)) + suffix
}

/** Up to 3 numbered posts: first line verbatim (cut to fit), then views and reactions. */
export function digestBody(channel: DigestChannel): string {
  const posts = channel.top.slice(0, Math.floor(CARD_BODY_LINES / 2))
  if (posts.length === 0) return channel.recent ? 'No posts in the last 24 h' : 'No new posts to show.'
  return posts
    .flatMap((p, i) => {
      const first = p.text.split('\n').map(l => l.trim()).find(Boolean) ?? '(no text)'
      const label = `${i + 1} `
      return [
        label + fitWidth(first, LINE_UNITS - textWidth(label)),
        `   ${formatCount(p.views)} views · ${formatCount(p.reactions)} reactions`,
      ]
    })
    .join('\n')
}

/** Title, then the ad text verbatim cut to fit, then [button] as plain text (nothing is clickable). */
export function sponsoredBody(ad: Sponsored, budget = CARD_BODY_LINES): string {
  const title = ad.title.trim() ? wrapText(ad.title.trim()).slice(0, 2) : []
  const button = ad.button.trim() ? [fitWidth(`[${ad.button.trim()}]`, LINE_UNITS)] : []
  const room = Math.max(1, budget - title.length - button.length)
  const text = wrapText(ad.text.trim()).filter(Boolean)
  const body = text.length > room ? [...text.slice(0, room - 1), fitWidth(text[room - 1] + '…', LINE_UNITS)] : text
  return [...title, ...body, ...button].join('\n')
}

export function digestFooter(page: DigestPage): string {
  if (page.kind === 'sponsored') return 'menu: Sponsor info · ▼ next'
  return doneMessage(page) ? 'tap done (mark read) · ▼ next · 2x back' : '▼ next · 2x back'
}

export function digestPage(page: DigestPage): Page {
  const sponsored = page.kind === 'sponsored'
  return {
    id: 'digest',
    texts: [
      { name: 'hdr', ...HEADER, content: digestHeader(page), dim: true },
      { name: 'body', ...BODY, content: sponsored ? sponsoredBody(page.ad) : digestBody(page.channel), capture: true },
      { name: 'ftr', ...FOOTER, content: digestFooter(page), dim: true },
    ],
    menu: sponsored
      ? [{ name: 'Sponsor info', id: MENU_SPONSOR_INFO }]
      : [
          { name: 'Refresh digest', id: MENU_REFRESH_DIGEST },
          { name: 'Back to inbox', id: MENU_BACK_TO_INBOX },
        ],
  }
}

/** Who is behind the ad. This page may scroll: it needs no swipes, only 2x back. */
export function sponsorInfoPage(ad: Sponsored): Page {
  const info = [ad.sponsorInfo.trim(), ad.additionalInfo.trim()].filter(Boolean).join('\n\n') || 'No sponsor details given.'
  return {
    id: 'sponsor-info',
    texts: [
      { name: 'hdr', ...HEADER, content: 'Sponsor info', dim: true },
      { name: 'body', ...BODY, content: info, capture: true },
      { name: 'ftr', ...FOOTER, content: '2x back', dim: true },
    ],
  }
}
