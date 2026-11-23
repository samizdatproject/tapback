import type { Input } from '../bridge'
import type { Card, ClientMsg, Inbox, InboxChat, SentMsg } from '../net'
import type { State } from '../state'
import { MENU_MUTE, MENU_SNOOZE, MUTE_MINUTES, SNOOZE_MINUTES, cardHeader, cardPage } from './card'
import { LIST_MAX_ITEMS, bodyOf, footerText, headerText, inboxRows, planInbox, type ShownInbox } from './format'
import { MENU_REFRESH, inboxPage } from './inbox'
import { introPage } from './intro'
import type { ScreenManager } from './manager'
import { neighbour, position } from './nav'
import { buildReplies, repliesHeader, repliesPage, type Reply } from './replies'
import { SendFlow, sendingPage, sendingText, type SendPhase, type SendingContext } from './sending'

const OPEN_TIMEOUT_MS = 8000
const CLICK_AFTER_DOUBLE_MS = 300 // a double-tap can trail a stray single tap
const RESULT_MS = 1000 // how long "Sent ●" / "Not sent" stay up

type View =
  | { name: 'intro' }
  | { name: 'inbox' }
  | { name: 'card'; card: Card }
  | { name: 'replies'; card: Card; replies: Reply[] }
  | { name: 'sending'; card: Card; replies: Reply[]; flow: SendFlow; ctx: SendingContext }

/** The glasses state machine: maps app state, inputs and server replies to pages. */
export class Glasses {
  private view: View = { name: 'intro' }
  private state: State | null = null

  // Inbox bookkeeping
  private shown: ShownInbox | null = null
  private entry = true // the next new inbox counts as (re)entering the Inbox
  private stale = false
  private lastInbox: Inbox | null = null
  private shownChats: InboxChat[] = [] // the chats behind the rows on screen
  private inboxStatus: string | null = null

  // Card navigation
  private order: string[] = [] // inbox order captured when the user left the Inbox
  private pending: { chatId: string; title: string; timer: ReturnType<typeof setTimeout> } | null = null

  private lastDoubleAt = -Infinity
  private delay: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly screens: ScreenManager,
    private readonly send: (msg: ClientMsg) => boolean,
  ) {}

  private get chats(): InboxChat[] {
    return this.state?.inbox?.chats ?? []
  }

  render(state: State): void {
    this.state = state
    if (!state.token) {
      this.reset()
      if (this.screens.pageId !== 'intro') this.screens.show(introPage())
      return
    }
    if (this.view.name === 'intro') this.view = { name: 'inbox' }
    if (this.view.name !== 'inbox') {
      // Other pages read the latest state when they need it. Tracking the inbox
      // here keeps the next *new* one counting as re-entry (see toInbox).
      this.lastInbox = state.inbox
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
    this.screens.setText('hdr', this.inboxStatus ?? headerText(state.inbox?.totals ?? null))
    this.screens.setText('ftr', footerText(state.link, this.stale))
  }

  /** A new pick on the phone: the Inbox list may be rebuilt. */
  refresh(): void {
    this.entry = true
    if (this.state && this.view.name === 'inbox') this.render(this.state)
  }

  input(input: Input): void {
    const now = Date.now()
    if (input.kind === 'DOUBLE') this.lastDoubleAt = now
    else if ((input.kind === 'CLICK' || input.kind === 'LIST_SELECT') && now - this.lastDoubleAt < CLICK_AFTER_DOUBLE_MS) {
      return
    }
    if (input.kind === 'EXIT') {
      this.reset()
      return
    }
    // While a chat is opening, only "back" counts: anything else would drop a
    // card the server has already marked read.
    if (this.pending && input.kind !== 'DOUBLE') return
    const view = this.view
    switch (view.name) {
      case 'intro':
        if (input.kind === 'DOUBLE') this.screens.exit()
        break
      case 'inbox':
        if (input.kind === 'DOUBLE') this.screens.exit() // root page
        else if (input.kind === 'LIST_SELECT') {
          const chat = this.shownChats[input.index]
          if (chat) this.open(chat)
        } else if (input.kind === 'MENU' && input.itemId === MENU_REFRESH) {
          this.refresh()
          this.send({ type: 'open_inbox' })
        }
        break
      case 'card':
        if (input.kind === 'CLICK') this.showReplies(view.card)
        else if (input.kind === 'SWIPE_DOWN') this.step(view.card.chat.id, 1)
        else if (input.kind === 'SWIPE_UP') this.step(view.card.chat.id, -1)
        else if (input.kind === 'DOUBLE') this.toInbox()
        else if (input.kind === 'MENU' && (input.itemId === MENU_MUTE || input.itemId === MENU_SNOOZE)) {
          const chatId = view.card.chat.id
          const mute = input.itemId === MENU_MUTE
          this.send({ type: mute ? 'mute' : 'snooze', chatId, minutes: mute ? MUTE_MINUTES : SNOOZE_MINUTES })
          this.step(chatId, 1)
        }
        break
      case 'replies':
        if (input.kind === 'DOUBLE') this.showCard(view.card)
        else if (input.kind === 'LIST_SELECT') {
          const reply = view.replies[input.index]
          if (reply?.kind === 'dictate') this.screens.setText('ftr', 'Dictation is coming soon · 2x back')
          else if (reply) this.startSending(view.card, view.replies, reply)
        }
        break
      case 'sending': {
        const phase = view.flow.phase.phase
        if (phase === 'counting' && (input.kind === 'DOUBLE' || input.kind === 'FG_ENTER')) view.flow.cancel()
        else if (phase === 'failed' && input.kind === 'CLICK') view.flow.retry()
        else if (phase === 'failed' && input.kind === 'DOUBLE') this.showReplies(view.card)
        else if (phase === 'sent' && input.kind === 'DOUBLE') this.toInbox()
        break
      }
    }
  }

  onCard(card: Card): void {
    if (!this.pending || this.pending.chatId !== card.chat.id) return // not asked for (or given up on)
    this.clearPending()
    this.showCard(card)
  }

  onSent(msg: SentMsg): void {
    if (this.view.name === 'sending') this.view.flow.ack(msg)
  }

  onError(human: string): void {
    if (this.pending) {
      this.clearPending()
      this.openFailed(human)
    } else if (this.view.name === 'sending') {
      this.view.flow.fail(human)
    }
  }

  // ---- transitions ----

  private open(chat: InboxChat): void {
    if (this.view.name === 'inbox') this.order = this.chats.map(c => c.id)
    this.leave()
    const title = chat.title.trim() || 'chat'
    if (!this.send({ type: 'open_chat', chatId: chat.id })) {
      this.openFailed('Offline · try again in a moment')
      return
    }
    const timer = setTimeout(() => {
      this.pending = null
      this.openFailed(`Couldn't open ${title}`)
    }, OPEN_TIMEOUT_MS)
    this.pending = { chatId: chat.id, title, timer }
    this.status(`Opening ${title}…`)
  }

  /** After "Sent ●" there is nothing to go back to, so a failed open lands on the Inbox. */
  private openFailed(human: string): void {
    if (this.view.name === 'sending') this.toInbox()
    this.flash(human)
  }

  private step(fromChatId: string, dir: 1 | -1): void {
    const next = neighbour(this.order, this.chats, fromChatId, dir)
    if (next) this.open(next)
    else this.toInbox()
  }

  private showCard(card: Card): void {
    this.leave()
    this.view = { name: 'card', card }
    this.screens.show(cardPage(card, position(this.order, this.chats, card.chat.id)))
  }

  private showReplies(card: Card): void {
    this.leave()
    const replies = buildReplies(card.suggestions)
    this.view = { name: 'replies', card, replies }
    this.screens.show(repliesPage(card, replies))
  }

  private toInbox(): void {
    this.leave()
    this.view = { name: 'inbox' }
    this.inboxStatus = null
    this.entry = true // the fresh inbox (e.g. without a just-muted chat) may rebuild the list
    this.send({ type: 'open_inbox' })
    if (this.state) this.render(this.state) // not on the Inbox page, so this rebuilds it
  }

  private startSending(card: Card, replies: Reply[], reply: Reply): void {
    this.leave()
    const ctx: SendingContext = {
      chatTitle: card.chat.title.trim() || 'chat',
      replyToSender: card.replyTo?.sender.trim() || null,
      label: reply.kind === 'text' ? reply.text : 'React: thumbs up',
      undoMs: 2000,
      after: '',
    }
    const flow = new SendFlow({
      undoMs: ctx.undoMs,
      send: clientMsgId =>
        this.send({
          type: 'send',
          chatId: card.chat.id,
          replyTo: card.replyTo?.id ?? null,
          ...(reply.kind === 'reaction' ? { reaction: reply.reaction } : { text: ctx.label }),
          clientMsgId,
        }),
      onChange: phase => this.onSendPhase(flow, phase),
    })
    this.view = { name: 'sending', card, replies, flow, ctx }
    this.screens.show(sendingPage(sendingText(ctx, flow.phase)))
    flow.start()
  }

  private onSendPhase(flow: SendFlow, phase: SendPhase): void {
    const view = this.view
    if (view.name !== 'sending' || view.flow !== flow) return
    if (phase.phase === 'sent') {
      const next = neighbour(this.order, this.chats, view.card.chat.id, 1)
      view.ctx.after = next ? `next: ${next.title.trim() || 'chat'} (${next.unread})` : 'back to inbox'
      this.later(() => (next ? this.open(next) : this.toInbox()))
    } else if (phase.phase === 'cancelled') {
      this.later(() => this.showReplies(view.card))
    }
    this.screens.setText('msg', sendingText(view.ctx, phase))
  }

  // ---- helpers ----

  /** Shows a short status where the current page has room for it. */
  private status(text: string | null): void {
    const view = this.view
    switch (view.name) {
      case 'inbox':
        this.inboxStatus = text
        this.screens.setText('hdr', text ?? headerText(this.state?.inbox?.totals ?? null))
        break
      case 'card':
        this.screens.setText('hdr', text ?? cardHeader(view.card, position(this.order, this.chats, view.card.chat.id)))
        break
      case 'replies':
        this.screens.setText('hdr', text ?? repliesHeader(view.card))
        break
      case 'sending':
        if (text) this.screens.setText('msg', text)
        break
    }
  }

  /** A status that goes away after a few seconds. */
  private flash(text: string): void {
    this.status(text)
    this.later(() => this.status(null), 3000)
  }

  private later(fn: () => void, ms = RESULT_MS): void {
    if (this.delay) clearTimeout(this.delay)
    this.delay = setTimeout(() => {
      this.delay = null
      fn()
    }, ms)
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  /** Called before switching pages: stop timers and any send in progress. */
  private leave(): void {
    if (this.delay) clearTimeout(this.delay)
    this.delay = null
    this.clearPending()
    if (this.view.name === 'sending') this.view.flow.dispose()
  }

  private reset(): void {
    this.leave()
    this.view = { name: 'intro' }
    this.shown = null
    this.shownChats = []
    this.entry = true
    this.inboxStatus = null
  }
}
