import type { Inbox, InboxChat } from '../net'
import type { State } from '../state'
import { LIST_MAX_ITEMS, bodyOf, footerText, headerText, inboxRows, planInbox, type ShownInbox } from './format'
import { inboxPage } from './inbox'
import { introPage } from './intro'
import type { ScreenManager } from './manager'

/** Maps app state to glasses pages. */
export class Glasses {
  private shown: ShownInbox | null = null
  private entry = true // the next new inbox counts as (re)entering the Inbox
  private stale = false
  private lastInbox: Inbox | null = null
  private shownChats: InboxChat[] = [] // the chats behind the rows on screen

  constructor(private readonly screens: ScreenManager) {}

  render(state: State): void {
    if (!state.token) {
      this.shown = null
      this.shownChats = []
      this.entry = true
      if (this.screens.pageId !== 'intro') this.screens.show(introPage())
      return
    }
    const rows = state.inbox ? inboxRows(state.inbox.chats) : null
    const plan = this.screens.pageId === 'inbox' ? planInbox(this.shown, rows, this.entry) : 'rebuild'
    this.stale = plan === 'stale'
    if (plan === 'rebuild') {
      this.shown = { body: bodyOf(rows), rows: rows ?? [] }
      this.shownChats = state.inbox?.chats.slice(0, LIST_MAX_ITEMS) ?? []
      this.screens.show(inboxPage(state, rows, false))
    }
    if (state.inbox && state.inbox !== this.lastInbox) this.entry = false
    this.lastInbox = state.inbox
    this.screens.setText('hdr', headerText(state.inbox?.totals ?? null))
    this.screens.setText('ftr', footerText(state.link, this.stale))
  }

  /**
   * Menu "Refresh" or a new pick on the phone: the list may be rebuilt now and
   * once more when the next inbox arrives (the answer to `open_inbox`).
   */
  refresh(state: State): void {
    this.entry = true
    this.render(state)
  }

  /** The chat at a list index as drawn, which may differ from the latest inbox. */
  chatAt(index: number): InboxChat | undefined {
    return this.screens.pageId === 'inbox' ? this.shownChats[index] : undefined
  }

  exit(): void {
    this.screens.exit()
  }
}
