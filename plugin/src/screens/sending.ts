import type { SentMsg } from '../net'
import type { Page } from './manager'
import { LINE_UNITS, fitWidth, wrapText } from './text'

export type SendPhase =
  | { phase: 'counting'; leftMs: number }
  | { phase: 'sending' }
  | { phase: 'sent'; at: string }
  | { phase: 'failed'; human: string }
  | { phase: 'cancelled' }

export interface SendFlowOptions {
  /** Called once the undo window has passed; returns false if it could not go out. */
  send(clientMsgId: string): boolean
  onChange(phase: SendPhase): void
  newId?: () => string
  undoMs?: number
  tickMs?: number
  timeoutMs?: number
}

/**
 * The undo window: count down, then send once, then wait for `sent`. Undo is
 * possible only while counting. Never resends by itself; `retry()` re-runs the
 * window. Every attempt gets a fresh clientMsgId, so a late answer to an
 * earlier attempt is ignored.
 */
export class SendFlow {
  private clientMsgId = ''
  private state: SendPhase
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly undoMs: number
  private readonly tickMs: number
  private readonly timeoutMs: number

  constructor(private readonly opts: SendFlowOptions) {
    this.undoMs = opts.undoMs ?? 2000
    this.tickMs = opts.tickMs ?? 500
    this.timeoutMs = opts.timeoutMs ?? 8000
    this.state = { phase: 'counting', leftMs: this.undoMs }
  }

  get phase(): SendPhase {
    return this.state
  }

  start(): void {
    this.set({ phase: 'counting', leftMs: this.undoMs })
    this.tick()
  }

  /** Undo. True if the message was stopped in time. */
  cancel(): boolean {
    if (this.state.phase !== 'counting') return false
    this.clear()
    this.set({ phase: 'cancelled' })
    return true
  }

  ack(msg: SentMsg): void {
    if (msg.clientMsgId !== this.clientMsgId || this.state.phase !== 'sending') return
    this.clear()
    this.set(msg.ok ? { phase: 'sent', at: msg.at } : { phase: 'failed', human: msg.human })
  }

  /** A server error while waiting (e.g. rate limit) fails this send. */
  fail(human: string): void {
    if (this.state.phase !== 'sending') return
    this.clear()
    this.set({ phase: 'failed', human })
  }

  retry(): void {
    if (this.state.phase === 'failed') this.start()
  }

  dispose(): void {
    this.clear()
  }

  private tick(): void {
    if (this.state.phase !== 'counting') return
    const left = this.state.leftMs
    if (left <= 0) {
      this.fire()
      return
    }
    this.timer = setTimeout(() => {
      this.set({ phase: 'counting', leftMs: Math.max(0, left - this.tickMs) })
      this.tick()
    }, this.tickMs)
  }

  private fire(): void {
    this.clientMsgId = (this.opts.newId ?? (() => crypto.randomUUID()))()
    this.set({ phase: 'sending' })
    if (!this.opts.send(this.clientMsgId)) {
      this.set({ phase: 'failed', human: 'Offline. Not sent.' })
      return
    }
    this.timer = setTimeout(() => this.set({ phase: 'failed', human: 'No answer from the server. It may not have been sent.' }), this.timeoutMs)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private set(phase: SendPhase): void {
    this.state = phase
    this.opts.onChange(phase)
  }
}

const BAR_CELLS = 24

export function progressBar(leftMs: number, totalMs: number, cells = BAR_CELLS): string {
  const done = Math.round(cells * Math.min(1, Math.max(0, 1 - leftMs / totalMs)))
  return '━'.repeat(done) + '─'.repeat(cells - done)
}

export interface SendingContext {
  chatTitle: string
  replyToSender: string | null
  /** What goes out, as the user should read it. */
  label: string
  undoMs: number
  /** e.g. "next: Alice (1)" or "back to inbox". */
  after: string
}

export function sendingText(ctx: SendingContext, phase: SendPhase): string {
  const to = fitWidth(
    `Sending to ${ctx.chatTitle}${ctx.replyToSender ? ` · reply to ${ctx.replyToSender}` : ''}`,
    LINE_UNITS,
  )
  const quote = wrapText(`"${ctx.label}"`).slice(0, 3)
  const head = [to, '', ...quote, '']
  switch (phase.phase) {
    case 'counting':
      return [...head, `${progressBar(phase.leftMs, ctx.undoMs)}  ${Math.ceil(phase.leftMs / 1000)} s`, '', '2x undo'].join('\n')
    case 'sending':
      return [...head, 'Sending…'].join('\n')
    case 'sent':
      return fitWidth(`Sent ●${phase.at ? ` ${phase.at}` : ''} · ${ctx.after}`, LINE_UNITS)
    case 'failed':
      return [...head, ...wrapText(phase.human).slice(0, 2), '', 'tap retry · 2x back'].join('\n')
    case 'cancelled':
      return 'Not sent'
  }
}

export function sendingPage(content: string): Page {
  return { id: 'sending', texts: [{ name: 'msg', x: 0, y: 0, w: 576, h: 288, content, capture: true }] }
}
