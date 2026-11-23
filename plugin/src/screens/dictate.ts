import type { ClientMsg, SttMsg } from '../net'
import type { Page } from './manager'
import { LINE_UNITS, fitWidth, wrapText } from './text'

export type DictPhase =
  | { phase: 'starting' }
  | { phase: 'listening'; elapsedMs: number }
  | { phase: 'transcribing' }
  | { phase: 'preview'; text: string }
  | { phase: 'empty'; human: string }
  | { phase: 'cancelled' }

export interface DictationDeps {
  /** Turns the microphone on or off; resolves false if it could not. */
  mic(on: boolean): Promise<boolean>
  send(msg: ClientMsg): boolean
  sendAudio(pcm: Uint8Array): boolean
  onChange(phase: DictPhase): void
  maxMs?: number
  tickMs?: number
  sttTimeoutMs?: number
}

/**
 * One dictation: mic on → audio_begin → PCM frames → audio_end → stt.
 * The invariant that matters: whenever this is not listening, the mic is off.
 */
export class Dictation {
  private state: DictPhase = { phase: 'starting' }
  private micOn = false
  private stopWanted = false // a release that came while the mic was still starting
  private timer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private readonly maxMs: number
  private readonly tickMs: number
  private readonly sttTimeoutMs: number

  constructor(private readonly deps: DictationDeps) {
    this.maxMs = deps.maxMs ?? 15_000
    this.tickMs = deps.tickMs ?? 500
    this.sttTimeoutMs = deps.sttTimeoutMs ?? 20_000
  }

  get phase(): DictPhase {
    return this.state
  }

  get active(): boolean {
    return this.state.phase === 'starting' || this.state.phase === 'listening'
  }

  async start(): Promise<void> {
    this.clear()
    this.stopWanted = false
    this.set({ phase: 'starting' })
    const ok = await this.deps.mic(true).catch(() => false)
    if (this.state.phase !== 'starting' || !ok) {
      // Cancelled while starting, or a start that "failed": the host may still
      // have opened the mic, so always switch it off.
      void this.deps.mic(false).catch(() => false)
      if (!ok && this.state.phase === 'starting') this.set({ phase: 'empty', human: 'The microphone is not available.' })
      return
    }
    this.micOn = true
    if (!this.deps.send({ type: 'audio_begin' })) {
      this.micOff()
      this.set({ phase: 'empty', human: 'Offline. Try again in a moment.' })
      return
    }
    this.startedAt = Date.now()
    this.set({ phase: 'listening', elapsedMs: 0 })
    if (this.stopWanted) this.stop()
    else this.tick()
  }

  /** PCM from the glasses; forwarded only while listening. */
  frame(pcm: Uint8Array): void {
    if (this.state.phase === 'listening') this.deps.sendAudio(pcm)
  }

  /** Done speaking: send what we have for transcription. */
  stop(): void {
    if (this.state.phase === 'starting') {
      this.stopWanted = true
      return
    }
    if (this.state.phase !== 'listening') return
    this.clear()
    this.micOff()
    this.deps.send({ type: 'audio_end' })
    this.set({ phase: 'transcribing' })
    this.timer = setTimeout(
      () => this.set({ phase: 'empty', human: 'No answer from speech-to-text.' }),
      this.sttTimeoutMs,
    )
  }

  /** Throw the recording away. */
  cancel(): void {
    const wasListening = this.state.phase === 'listening'
    if (!this.active) return
    this.clear()
    this.micOff()
    if (wasListening) this.deps.send({ type: 'audio_cancel' })
    this.set({ phase: 'cancelled' })
  }

  onStt(msg: SttMsg): void {
    if (this.state.phase !== 'transcribing') return
    this.clear()
    this.set(msg.text ? { phase: 'preview', text: msg.text } : { phase: 'empty', human: msg.human || "Didn't catch that" })
  }

  /** A server error or a dropped connection: stop and say why. */
  fail(human: string): void {
    if (this.state.phase !== 'transcribing' && !this.active) return
    if (this.state.phase === 'listening') this.deps.send({ type: 'audio_cancel' })
    this.clear()
    this.micOff()
    this.set({ phase: 'empty', human })
  }

  /** Leaving the page, disconnecting or exiting: never leave the mic on. */
  dispose(): void {
    if (this.active) this.cancel()
    this.clear()
    this.micOff()
  }

  private tick(): void {
    this.timer = setTimeout(() => {
      if (this.state.phase !== 'listening') return
      const elapsedMs = Date.now() - this.startedAt
      if (elapsedMs >= this.maxMs) {
        this.stop()
        return
      }
      this.set({ phase: 'listening', elapsedMs })
      this.tick()
    }, this.tickMs)
  }

  private micOff(): void {
    if (!this.micOn) return
    this.micOn = false
    void this.deps.mic(false).catch(() => false)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private set(phase: DictPhase): void {
    this.state = phase
    this.deps.onChange(phase)
  }
}

const BAR_CELLS = 24
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "To Alice:" or "Re Dana:" */
export function dictateTarget(chatTitle: string, replyToSender: string | null): string {
  return fitWidth(replyToSender ? `Re ${replyToSender}:` : `To ${chatTitle}:`, LINE_UNITS)
}

export function dictateText(phase: DictPhase, target: string, route: 'hold' | 'tap', maxMs = 15_000): string {
  switch (phase.phase) {
    case 'starting':
      return 'Starting the microphone…'
    case 'listening': {
      const done = Math.min(BAR_CELLS, Math.round((BAR_CELLS * phase.elapsedMs) / maxMs))
      return [
        `● Listening… ${route === 'hold' ? 'release' : 'tap'} to stop  ${clock(phase.elapsedMs)}`,
        `${'━'.repeat(done)}${'─'.repeat(BAR_CELLS - done)} max ${clock(maxMs)}`,
        '',
        '(audio goes only to your own server)',
        '',
        '2x cancel',
      ].join('\n')
    }
    case 'transcribing':
      return [target, '', 'Transcribing…'].join('\n')
    case 'preview': {
      const lines = wrapText(`"${phase.text}"`)
      const shown = lines.length > 6 ? [...lines.slice(0, 5), fitWidth(lines[5] + '…', LINE_UNITS)] : lines
      return [target, ...shown, '', 'tap send · 2x discard'].join('\n')
    }
    case 'empty':
      return [...wrapText(phase.human).slice(0, 3), '', 'tap retry · 2x back'].join('\n')
    case 'cancelled':
      return 'Cancelled'
  }
}

export function dictatePage(content: string): Page {
  return { id: 'dictate', texts: [{ name: 'msg', x: 0, y: 0, w: 576, h: 288, content, capture: true }] }
}
