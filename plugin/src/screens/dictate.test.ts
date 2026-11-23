import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg } from '../net'
import { Dictation, dictateText, type DictPhase } from './dictate'

function setup(micOk = true, sendOk = true) {
  const sent: ClientMsg['type'][] = []
  const audio: Uint8Array[] = []
  const mic: boolean[] = []
  const phases: DictPhase[] = []
  const d = new Dictation({
    mic: async on => (mic.push(on), on ? micOk : true),
    send: m => (sent.push(m.type), sendOk),
    sendAudio: pcm => (audio.push(pcm), true),
    onChange: p => phases.push(p),
    newId: () => 'd1',
  })
  const micIsOn = () => mic.filter(Boolean).length > mic.filter(x => !x).length
  return { d, sent, audio, mic, phases, micIsOn, last: () => phases[phases.length - 1] }
}
const pcm = new Uint8Array([1, 2, 3, 4])

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Dictation', () => {
  it('mic on, audio_begin, frames, then mic off and audio_end on stop', async () => {
    const t = setup()
    t.d.frame(pcm) // before start: dropped
    await t.d.start()
    expect(t.sent).toEqual(['audio_begin'])
    expect(t.micIsOn()).toBe(true)
    t.d.frame(pcm)
    t.d.frame(pcm)
    t.d.stop()
    t.d.frame(pcm) // after stop: dropped
    expect(t.audio).toHaveLength(2)
    expect(t.sent).toEqual(['audio_begin', 'audio_end'])
    expect(t.micIsOn()).toBe(false)
    expect(t.last()).toEqual({ phase: 'transcribing' })
  })

  it('previews the transcript, or explains an empty one', async () => {
    const t = setup()
    await t.d.start()
    t.d.stop()
    t.d.onStt({ id: 'd1', text: 'Running late', human: '' })
    expect(t.last()).toEqual({ phase: 'preview', text: 'Running late' })
    const u = setup()
    await u.d.start()
    u.d.stop()
    u.d.onStt({ id: 'd1', text: '', human: 'Too short. Hold while you speak.' })
    expect(u.last()).toEqual({ phase: 'empty', human: 'Too short. Hold while you speak.' })
  })

  it('ignores a transcript from an earlier dictation', async () => {
    let n = 0
    const phases: DictPhase[] = []
    const begins: string[] = []
    const d = new Dictation({
      mic: async () => true,
      send: m => (m.type === 'audio_begin' && begins.push(m.id), true),
      sendAudio: () => true,
      onChange: p => phases.push(p),
      newId: () => `d${++n}`,
    })
    await d.start()
    d.stop()
    await d.start() // the user retried before the first result came back
    d.stop()
    expect(begins).toEqual(['d1', 'd2'])
    d.onStt({ id: 'd1', text: 'old words', human: '' })
    expect(d.phase).toEqual({ phase: 'transcribing' })
    d.onStt({ id: 'd2', text: 'new words', human: '' })
    expect(d.phase).toEqual({ phase: 'preview', text: 'new words' })
  })

  it('dispose is silent: it schedules no page change', async () => {
    const t = setup()
    await t.d.start()
    const before = t.phases.length
    t.d.dispose()
    expect(t.phases.length).toBe(before)
    expect(t.micIsOn()).toBe(false)
  })

  it('cancel (double-tap or menu) turns the mic off and sends audio_cancel', async () => {
    const t = setup()
    await t.d.start()
    t.d.frame(pcm)
    t.d.cancel()
    t.d.frame(pcm)
    expect(t.sent).toEqual(['audio_begin', 'audio_cancel'])
    expect(t.audio).toHaveLength(1)
    expect(t.micIsOn()).toBe(false)
    expect(t.last()).toEqual({ phase: 'cancelled' })
  })

  it('cancel while the mic is still starting leaves it off', async () => {
    const t = setup()
    const started = t.d.start()
    t.d.cancel()
    await started
    expect(t.micIsOn()).toBe(false)
    expect(t.sent).toEqual([])
  })

  it('a release while starting stops right after the mic came on', async () => {
    const t = setup()
    const started = t.d.start()
    t.d.stop()
    await started
    expect(t.sent).toEqual(['audio_begin', 'audio_end'])
    expect(t.micIsOn()).toBe(false)
  })

  it('stops by itself at 15 s', async () => {
    const t = setup()
    await t.d.start()
    vi.advanceTimersByTime(14_000)
    expect(t.last()).toMatchObject({ phase: 'listening' })
    vi.advanceTimersByTime(1_500)
    expect(t.sent).toContain('audio_end')
    expect(t.micIsOn()).toBe(false)
  })

  it('a server error or lost connection stops the mic', async () => {
    const t = setup()
    await t.d.start()
    t.d.fail('Connection lost.')
    expect(t.micIsOn()).toBe(false)
    expect(t.sent).toEqual(['audio_begin', 'audio_cancel'])
    expect(t.last()).toEqual({ phase: 'empty', human: 'Connection lost.' })
  })

  it('dispose (page change, exit) always leaves the mic off', async () => {
    const t = setup()
    await t.d.start()
    t.d.dispose()
    expect(t.micIsOn()).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(t.sent).toEqual(['audio_begin', 'audio_cancel'])
  })

  it('reports a missing mic and an offline socket without leaving the mic on', async () => {
    const noMic = setup(false)
    await noMic.d.start()
    expect(noMic.last()).toEqual({ phase: 'empty', human: 'The microphone is not available.' })
    expect(noMic.sent).toEqual([])
    expect(noMic.mic).toEqual([true, false]) // a failed start may still have opened it
    const offline = setup(true, false)
    await offline.d.start()
    expect(offline.micIsOn()).toBe(false)
    expect(offline.last().phase).toBe('empty')
  })

  it('gives up waiting for speech-to-text after 20 s', async () => {
    const t = setup()
    await t.d.start()
    t.d.stop()
    vi.advanceTimersByTime(20_000)
    expect(t.last()).toEqual({ phase: 'empty', human: 'No answer from speech-to-text.' })
  })
})

describe('dictateText', () => {
  it('marks a cut transcript in the preview', () => {
    const text = dictateText({ phase: 'preview', text: 'word '.repeat(120) }, 'To Alice:', 'tap')
    const lines = text.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[6].endsWith('…')).toBe(true)
  })

  it('draws the listening page', () => {
    expect(dictateText({ phase: 'listening', elapsedMs: 3000 }, 'To Alice:', 'hold')).toBe(
      [
        '● Listening… release to stop  0:03',
        `${'━'.repeat(5)}${'─'.repeat(19)} max 0:15`,
        '',
        '(audio goes only to your own server)',
        '',
        '2x cancel',
      ].join('\n'),
    )
    expect(dictateText({ phase: 'listening', elapsedMs: 0 }, 'x', 'tap')).toContain('tap to stop')
  })

  it('previews and explains', () => {
    expect(dictateText({ phase: 'preview', text: 'On my way' }, 'Re Dana:', 'hold')).toBe('Re Dana:\n"On my way"\n\ntap send · 2x discard')
    expect(dictateText({ phase: 'empty', human: "Didn't catch that" }, 'x', 'hold')).toBe("Didn't catch that\n\ntap retry · 2x back")
  })
})
