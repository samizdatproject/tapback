import type { State } from '../state'
import { CONNECTING_TEXT, EMPTY_TEXT, footerText, headerText } from './format'
import type { Page } from './manager'

export const MENU_REFRESH = 1

const HEADER = { x: 0, y: 0, w: 576, h: 40 }
const BODY = { x: 0, y: 40, w: 576, h: 208 }
const FOOTER = { x: 0, y: 248, w: 576, h: 40 }

/**
 * Root page once paired: live header, the picked chats (or a message), and a
 * dim footer. `rows === null` means no inbox has arrived yet.
 */
export function inboxPage(state: State, rows: string[] | null, stale: boolean): Page {
  const texts: Page['texts'] = [
    { name: 'hdr', ...HEADER, content: headerText(state.inbox?.totals ?? null) },
    { name: 'ftr', ...FOOTER, content: footerText(state.link, stale), dim: true },
  ]
  const page: Page = { id: 'inbox', texts, menu: [{ name: 'Refresh', id: MENU_REFRESH }] }
  if (rows && rows.length > 0) {
    page.list = { name: 'chats', ...BODY, items: rows }
  } else {
    texts.push({ name: 'body', ...BODY, content: rows ? EMPTY_TEXT : CONNECTING_TEXT, capture: true })
  }
  return page
}
