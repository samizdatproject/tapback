import type { Input } from '../bridge'
import type { Card, ClientMsg, DigestChannel, Inbox, InboxChat, SentMsg, ServerError, SttMsg } from '../net'
import type { State } from '../state'
import { MENU_MUTE, MENU_SNOOZE, MUTE_MINUTES, SNOOZE_MINUTES, cardHeader, cardPage } from './card'
import { Dictation, dictatePage, dictateTarget, dictateText, type DictPhase } from './dictate'
import {
  MENU_BACK_TO_INBOX,
  MENU_REFRESH_DIGEST,
  MENU_SPONSOR_INFO,
  digestHeader,
  digestPage,
  digestPages,
  digestRow,
  doneMessage,
  sponsorInfoPage,
  type DigestPage,
} from './digest'
import { LIST_MAX_ITEMS, bodyOf, footerText, headerText, inboxRows, planInbox, type ShownInbox } from './format'
import { MENU_REFRESH, inboxPage } from './inbox'
import { introPage } from './intro'
import type { ScreenManager } from './manager'
import { neighbour, position } from './nav'
import { buildReplies, repliesHeader, repliesPage, type Reply } from './replies'
import { SendFlow, sendingPage, sendingText, type SendPhase, type SendingContext } from './sending'

const OPEN_TIMEOUT_MS = 8000
const DIGEST_TIMEOUT_MS = 30_000 // the server fetches every channel
const CLICK_AFTER_DOUBLE_MS = 300 // a double-tap can trail a stray single tap
const RESULT_MS = 1000 // how long "Sent ●" / "Not sent" stay up

type View =
  | { name: 'intro' }
  | { name: 'inbox' }
  | { name: 'card'; card: Card }
  | { name: 'replies'; card: Card; replies: Reply[] }
  | { name: 'sending'; card: Card; flow: SendFlow; ctx: SendingContext }
  | {
      name: 'dictate'
      card: Card
      from: 'card' | 'replies'
      route: 'hold' | 'tap'
      dict: Dictation
      target: string
    }
  | { name: 'digest'; pages: DigestPage[]; index: number }
  | { name: 'sponsor-info'; digest: Extract<View, { name: 'digest' }> }

/** What the glasses controller needs from the outside world. */
export interface GlassesIO {
  send(msg: ClientMsg): boolean
  sendAudio(pcm: Uint8Array): boolean
  /** Microphone on/off; resolves false if it could not be switched on. */
  mic(on: boolean): Promise<boolean>
}

type Pending = { for: 'open_chat' | 'digest_open'; chatId: string; title: string; timer: ReturnType<typeof setTimeout> }

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
  private shownDigest = false // a "Digest" row follows the chats
  private inboxStatus: string | null = null

  // Card navigation
  private order: string[] = [] // inbox order captured when the user left the Inbox
  private pending: Pending | null = null

  private digestFocus = '' // channel whose page the next digest opens at
  private shownCards = new WeakSet<Card>() // cards already reported with card_shown
  private viewedAds = new Set<string>() // sponsored randomIds already reported, across digest loads
  private lastDoubleAt = -Infinity
  private delay: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly screens: ScreenManager,
    private readonly io: GlassesIO,
  ) {}

  private send(msg: ClientMsg): boolean {
    return this.io.send(msg)
  }

  private get chats(): InboxChat[] {
    return this.state?.inbox?.chats ?? []
  }

  render(state: State): void {
    this.state = state
    if (!state.token) {
      this.reset()
      if (this.screens.pageId !== 'intro') void this.screens.show(introPage())
      return
    }
    if (this.view.name === 'intro') this.view = { name: 'inbox' }
    if (this.view.name === 'dictate' && state.link !== 'online') this.view.dict.fail('Connection lost. Not recorded.')
    if (this.view.name !== 'inbox') {
      // Other pages read the latest state when they need it. Tracking the inbox
      // here keeps the next *new* one counting as re-entry (see toInbox).
      this.lastInbox = state.inbox
      return
    }

    const all = state.inbox?.chats ?? []
    const digest = digestRow(all)
    const chats = all.slice(0, LIST_MAX_ITEMS - (digest ? 1 : 0))
    const rows = state.inbox ? [...inboxRows(chats), ...(digest ? [digest] : [])] : null
    const plan = this.screens.pageId === 'inbox' ? planInbox(this.shown, rows, this.entry) : 'rebuild'
    this.stale = plan === 'stale'
    if (plan === 'rebuild') {
      this.shown = { body: bodyOf(rows), rows: rows ?? [] }
      this.shownChats = chats
      this.shownDigest = digest !== null
      void this.screens.show(inboxPage(state, rows, false))
    }
    if (state.inbox && state.inbox !== this.lastInbox) this.entry = false
    this.lastInbox = state.inbox
    this.screens.setText('hdr', this.inboxStatus ?? headerText(state.inbox?.totals ?? null, state.inbox?.quiet))
    this.screens.setText('ftr', footerText(state.link, this.stale))
  }

  /** A new pick on the phone: the Inbox list may be rebuilt. */
  refresh(): void {
    this.entry = true
    if (this.state && this.view.name === 'inbox') this.render(this.state)
  }

  input(input: Input): void {
    if (input.kind === 'AUDIO') {
      if (this.view.name === 'dictate') this.view.dict.frame(input.pcm)
      return
    }
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
        if (input.kind === 'DOUBLE') {
          // While a chat or the digest is opening, double-tap cancels that instead of exiting.
          if (this.pending) {
            this.clearPending()
            this.status(null)
          } else this.screens.exit() // root page
        } else if (input.kind === 'LIST_SELECT') {
          const chat = this.shownChats[input.index]
          // Channels can't take replies and carry sponsored messages: they live in the digest.
          if (chat?.kind === 'channel') this.openDigest(chat.id)
          else if (chat) this.open(chat)
          else if (this.shownDigest && input.index === this.shownChats.length) this.openDigest()
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
        else if (input.kind === 'LONG_START') this.startDictation(view.card, 'card', 'hold')
        else if (input.kind === 'MENU' && (input.itemId === MENU_MUTE || input.itemId === MENU_SNOOZE)) {
          const chatId = view.card.chat.id
          const mute = input.itemId === MENU_MUTE
          this.send({ type: mute ? 'mute' : 'snooze', chatId, minutes: mute ? MUTE_MINUTES : SNOOZE_MINUTES })
          this.step(chatId, 1)
        }
        break
      case 'replies':
        if (input.kind === 'DOUBLE') this.showCard(view.card)
        else if (input.kind === 'LONG_START') this.startDictation(view.card, 'replies', 'hold')
        else if (input.kind === 'LIST_SELECT') {
          const reply = view.replies[input.index]
          if (reply?.kind === 'dictate') this.startDictation(view.card, 'replies', 'tap')
          else if (reply) this.startSending(view.card, reply)
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
      case 'dictate': {
        const { dict } = view
        const phase = dict.phase.phase
        if (dict.active) {
          if (input.kind === 'DOUBLE' || input.kind === 'FG_ENTER') dict.cancel()
          else if (view.route === 'hold' ? input.kind === 'LONG_END' : input.kind === 'CLICK') dict.stop()
        } else if (input.kind === 'DOUBLE' && phase !== 'cancelled') this.backFromDictation(view)
        else if (input.kind === 'CLICK' && phase === 'preview') {
          const text = (dict.phase as Extract<DictPhase, { phase: 'preview' }>).text
          this.startSending(view.card, { kind: 'text', label: text, text })
        } else if (input.kind === 'CLICK' && phase === 'empty') this.startDictation(view.card, view.from, 'tap')
        break
      }
      case 'digest': {
        const page = view.pages[view.index]
        if (input.kind === 'SWIPE_DOWN') this.showDigestPage(view, view.index + 1)
        else if (input.kind === 'SWIPE_UP' && view.index > 0) this.showDigestPage(view, view.index - 1)
        else if (input.kind === 'DOUBLE') this.toInbox()
        else if (input.kind === 'CLICK') this.digestDone(view)
        else if (input.kind === 'MENU') {
          if (input.itemId === MENU_REFRESH_DIGEST) this.openDigest()
          else if (input.itemId === MENU_BACK_TO_INBOX) this.toInbox()
          else if (input.itemId === MENU_SPONSOR_INFO && page?.kind === 'sponsored') {
            this.leave()
            this.view = { name: 'sponsor-info', digest: view }
            void this.screens.show(sponsorInfoPage(page.ad))
          }
        }
        break
      }
      case 'sponsor-info':
        if (input.kind === 'DOUBLE') this.showDigestPage(view.digest, view.digest.index)
        break
    }
  }

  onStt(msg: SttMsg): void {
    if (this.view.name === 'dictate') this.view.dict.onStt(msg)
  }

  onDigest(channels: DigestChannel[]): void {
    if (this.pending?.for !== 'digest_open') return
    this.clearPending()
    const pages = digestPages(channels)
    if (pages.length === 0) {
      this.flash('No channels picked for the digest')
      return
    }
    const at = pages.findIndex(p => p.kind === 'channel' && p.channel.id === this.digestFocus)
    this.showDigestPage({ name: 'digest', pages, index: 0 }, Math.max(0, at))
  }

  onCard(card: Card): void {
    if (!this.pending || this.pending.chatId !== card.chat.id) return // not asked for (or given up on)
    this.clearPending()
    this.showCard(card)
  }

  onSent(msg: SentMsg): void {
    if (this.view.name === 'sending') this.view.flow.ack(msg)
  }

  /** Errors name the request they answer (`for`), so each lands on the flow that sent it. */
  onError(err: ServerError): void {
    const p = this.pending
    if (p && (err.for === undefined || (err.for === p.for && (!err.chatId || err.chatId === p.chatId)))) {
      this.clearPending()
      this.openFailed(err.human)
    } else if (this.view.name === 'sending' && (err.for === undefined || err.for === 'send')) {
      this.view.flow.fail(err.human)
    } else if (this.view.name === 'dictate' && (err.for === undefined || err.for.startsWith('audio_'))) {
      this.view.dict.fail(err.human)
    } else if ((err.for === 'mute' || err.for === 'snooze') && !p) {
      this.flash(`Couldn't ${err.for}: ${err.human}`)
    }
  }

  // ---- transitions ----

  private open(chat: InboxChat): void {
    if (this.view.name === 'inbox') this.order = this.chats.map(c => c.id)
    this.leave()
    const title = chat.title.trim() || 'chat'
    this.request({ type: 'open_chat', chatId: chat.id }, chat.id, `Opening ${title}…`, `Couldn't open ${title}`, OPEN_TIMEOUT_MS)
  }

  /** Opens the digest, at `channelId`'s page if given. */
  private openDigest(channelId = ''): void {
    this.leave()
    this.digestFocus = channelId
    this.request({ type: 'digest_open' }, '', 'Loading digest…', "Couldn't load the digest", DIGEST_TIMEOUT_MS)
  }

  /** Sends a request whose answer replaces the page; until then, shows `waiting`. */
  private request(
    msg: Extract<ClientMsg, { type: Pending['for'] }>,
    chatId: string,
    waiting: string,
    failed: string,
    timeoutMs: number,
  ): void {
    if (!this.send(msg)) {
      this.openFailed('Offline · try again in a moment')
      return
    }
    const timer = setTimeout(() => {
      this.pending = null
      this.openFailed(failed)
    }, timeoutMs)
    this.pending = { for: msg.type, chatId, title: waiting, timer }
    this.status(waiting)
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
    const view: View = { name: 'card', card }
    this.view = view
    void this.screens.show(cardPage(card, position(this.order, this.chats, card.chat.id))).then(drawn => {
      // The server marks the chat read only now that the card was really seen, once.
      if (!drawn || this.view !== view || card.readMaxId === null || this.shownCards.has(card)) return
      this.shownCards.add(card)
      this.send({ type: 'card_shown', chatId: card.chat.id, maxId: card.readMaxId })
    })
  }

  private startDictation(card: Card, from: 'card' | 'replies', route: 'hold' | 'tap'): void {
    this.leave()
    const target = dictateTarget(card.chat.title.trim() || 'chat', card.replyTo?.sender.trim() || null)
    const dict: Dictation = new Dictation({
      mic: on => this.io.mic(on),
      send: msg => this.send(msg),
      sendAudio: pcm => this.io.sendAudio(pcm),
      onChange: phase => this.onDictPhase(dict, phase),
    })
    this.view = { name: 'dictate', card, from, route, dict, target }
    void this.screens.show(dictatePage(dictateText(dict.phase, target, route)))
    void dict.start()
  }

  private onDictPhase(dict: Dictation, phase: DictPhase): void {
    const view = this.view
    if (view.name !== 'dictate' || view.dict !== dict) return
    if (phase.phase === 'cancelled') this.later(() => this.backFromDictation(view))
    this.screens.setText('msg', dictateText(phase, view.target, view.route))
  }

  private backFromDictation(view: Extract<View, { name: 'dictate' }>): void {
    if (view.from === 'card') this.showCard(view.card)
    else this.showReplies(view.card)
  }

  private showDigestPage(view: Extract<View, { name: 'digest' }>, index: number): void {
    const page = view.pages[index]
    if (!page) {
      this.toInbox()
      return
    }
    this.leave()
    view.index = index
    this.view = view
    void this.screens.show(digestPage(page)).then(drawn => {
      // Telegram counts an ad view only once it was really on screen, and only once.
      if (!drawn || page.kind !== 'sponsored' || this.view !== view || view.index !== index) return
      if (this.viewedAds.has(page.ad.randomId)) return
      this.viewedAds.add(page.ad.randomId)
      this.send({ type: 'sponsored_viewed', randomId: page.ad.randomId })
    })
  }

  private digestDone(view: Extract<View, { name: 'digest' }>): void {
    const page = view.pages[view.index]
    const msg = doneMessage(page)
    if (!page || !msg || !this.send(msg)) return
    page.channel.maxId = null // done once; the page no longer offers it
    this.screens.setText('ftr', 'Marked read ●')
    this.later(() => this.showDigestPage(view, view.index + 1), 800)
  }

  private showReplies(card: Card): void {
    this.leave()
    const replies = buildReplies(card.suggestions)
    this.view = { name: 'replies', card, replies }
    void this.screens.show(repliesPage(card, replies))
  }

  private toInbox(): void {
    this.leave()
    this.view = { name: 'inbox' }
    this.inboxStatus = null
    this.entry = true // the fresh inbox (e.g. without a just-muted chat) may rebuild the list
    this.send({ type: 'open_inbox' })
    if (this.state) this.render(this.state) // not on the Inbox page, so this rebuilds it
  }

  private startSending(card: Card, reply: Reply): void {
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
    this.view = { name: 'sending', card, flow, ctx }
    void this.screens.show(sendingPage(sendingText(ctx, flow.phase)))
    flow.start()
  }

  private onSendPhase(flow: SendFlow, phase: SendPhase): void {
    const view = this.view
    if (view.name !== 'sending' || view.flow !== flow) return
    if (phase.phase === 'sent') {
      // Quiet hours: nothing moves on by itself.
      const quiet = this.state?.inbox?.quiet?.active === true
      const next = quiet ? null : neighbour(this.order, this.chats, view.card.chat.id, 1)
      view.ctx.after = next
        ? `next: ${next.title.trim() || 'chat'} (${next.unread})`
        : quiet
          ? 'back to inbox (quiet hours)'
          : 'back to inbox'
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
        this.screens.setText('hdr', text ?? headerText(this.state?.inbox?.totals ?? null, this.state?.inbox?.quiet))
        break
      case 'card':
        this.screens.setText('hdr', text ?? cardHeader(view.card, position(this.order, this.chats, view.card.chat.id)))
        break
      case 'replies':
        this.screens.setText('hdr', text ?? repliesHeader(view.card))
        break
      case 'sending':
      case 'dictate':
        if (text) this.screens.setText('msg', text)
        break
      case 'digest': {
        const page = view.pages[view.index]
        if (page) this.screens.setText('hdr', text ?? digestHeader(page))
        break
      }
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
    if (this.view.name === 'dictate') this.view.dict.dispose() // the mic never outlives its page
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
