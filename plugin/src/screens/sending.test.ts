import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendFlow, progressBar, sendingText, type SendPhase } from './sending'

function setup(sendOk = true) {
  const phases: SendPhase[] = []
  const sent: string[] = []
  let n = 0
  const flow = new SendFlow({
    send: id => {
      sent.push(id)
      return sendOk
    },
    onChange: p => phases.push(p),
    newId: () => `id${++n}`,
  })
  return { flow, phases, sent, last: () => phases[phases.length - 1] }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SendFlow', () => {
  it('counts down 2 s in 500 ms steps, then sends once', () => {
    const { flow, phases, sent } = setup()
    flow.start()
    vi.advanceTimersByTime(1999)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual(['id1'])
    expect(phases.map(p => (p.phase === 'counting' ? p.leftMs : p.phase))).toEqual([2000, 1500, 1000, 500, 0, 'sending'])
  })

  it('undo during the window means nothing is sent', () => {
    const { flow, sent, last } = setup()
    flow.start()
    vi.advanceTimersByTime(1200)
    expect(flow.cancel()).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(sent).toEqual([])
    expect(last()).toEqual({ phase: 'cancelled' })
  })

  it('cannot undo once sent', () => {
    const { flow, last } = setup()
    flow.start()
    vi.advanceTimersByTime(2000)
    expect(flow.cancel()).toBe(false)
    expect(last()).toEqual({ phase: 'sending' })
  })

  it('reports success only for its own clientMsgId', () => {
    const { flow, last } = setup()
    flow.start()
    vi.advanceTimersByTime(2000)
    flow.ack({ clientMsgId: 'other', ok: true, at: '14:02' })
    expect(last()).toEqual({ phase: 'sending' })
    flow.ack({ clientMsgId: 'id1', ok: true, at: '14:02' })
    expect(last()).toEqual({ phase: 'sent', at: '14:02' })
    vi.advanceTimersByTime(10_000)
    expect(last()).toEqual({ phase: 'sent', at: '14:02' })
  })

  it('shows the server failure and retries with a fresh id after a new window', () => {
    const { flow, sent, last } = setup()
    flow.start()
    vi.advanceTimersByTime(2000)
    flow.ack({ clientMsgId: 'id1', ok: false, human: 'Rate limited' })
    expect(last()).toEqual({ phase: 'failed', human: 'Rate limited' })
    flow.retry()
    expect(last()).toEqual({ phase: 'counting', leftMs: 2000 })
    vi.advanceTimersByTime(2000)
    expect(sent).toEqual(['id1', 'id2'])
    flow.ack({ clientMsgId: 'id1', ok: true, at: 'late' })
    expect(last()).toEqual({ phase: 'sending' })
  })

  it('times out after 8 s without an answer and does not resend', () => {
    const { flow, sent, last } = setup()
    flow.start()
    vi.advanceTimersByTime(2000 + 7999)
    expect(last()).toEqual({ phase: 'sending' })
    vi.advanceTimersByTime(1)
    expect(last().phase).toBe('failed')
    vi.advanceTimersByTime(60_000)
    expect(sent).toHaveLength(1)
  })

  it('fails at once when offline', () => {
    const { flow, last } = setup(false)
    flow.start()
    vi.advanceTimersByTime(2000)
    expect(last()).toEqual({ phase: 'failed', human: 'Offline. Not sent.' })
  })

  it('stops quietly when disposed', () => {
    const { flow, sent } = setup()
    flow.start()
    flow.dispose()
    vi.advanceTimersByTime(10_000)
    expect(sent).toEqual([])
  })
})

describe('sending text', () => {
  const ctx = { chatTitle: 'Acme Work', replyToSender: 'Dana', label: 'Works for me', undoMs: 2000, after: 'next: Alice (1)' }

  it('draws the undo window', () => {
    expect(sendingText(ctx, { phase: 'counting', leftMs: 1000 })).toBe(
      ['Sending to Acme Work · reply to Dana', '', '"Works for me"', '', `${'━'.repeat(12)}${'─'.repeat(12)}  1 s`, '', '2x undo'].join('\n'),
    )
    expect(progressBar(2000, 2000)).toBe('─'.repeat(24))
    expect(progressBar(0, 2000)).toBe('━'.repeat(24))
  })

  it('confirms with ● and says what comes next', () => {
    expect(sendingText(ctx, { phase: 'sent', at: '14:02' })).toBe('Sent ● 14:02 · next: Alice (1)')
    expect(sendingText(ctx, { phase: 'failed', human: 'Rate limited' })).toContain('tap retry · 2x back')
    expect(sendingText(ctx, { phase: 'cancelled' })).toBe('Not sent')
  })
})
