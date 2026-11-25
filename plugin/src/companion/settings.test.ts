import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYWORDS, MAX_ITEMS, TRANSLATE_LANGS, addItem, cleanItem, cleanLang, removeItem, settingsBody } from './settings'

describe('triage settings model', () => {
  it('cleans like the server: lowercase, single spaces, no leading @ for VIPs', () => {
    expect(cleanItem('  @Dana  ', true)).toBe('dana')
    expect(cleanItem('Call   ME')).toBe('call me')
    expect(cleanItem('@keep', false)).toBe('@keep')
  })

  it('adds, refuses duplicates and blanks, and removes', () => {
    let list = addItem([], '@Dana', true).list
    expect(list).toEqual(['dana'])
    const dup = addItem(list, 'DANA', true)
    expect(dup.list).toBe(list)
    expect(dup.error).toBe('"dana" is already on the list.')
    expect(addItem(list, '   ').error).toBe('Type a name or word first.')
    list = addItem(list, 'lee').list
    expect(removeItem(list, 'dana')).toEqual(['lee'])
  })

  it('enforces the length and count limits', () => {
    expect(addItem([], 'x'.repeat(41)).error).toBe('Keep it under 40 characters.')
    const full = Array.from({ length: MAX_ITEMS }, (_, i) => `w${i}`)
    expect(addItem(full, 'one more').error).toBe('At most 30 items.')
  })

  it('reset to defaults uses the server defaults', () => {
    expect(DEFAULT_KEYWORDS).toEqual(['urgent', 'asap', 'now', 'today', 'call me', 'deadline', 'down', 'failed', 'liquidat*'])
  })

  it('keeps the breakthrough choice in the PUT body', () => {
    const s = { vip: [], keywords: [], quiet: { enabled: false, start: '22:00', end: '08:00' }, breakthrough: true }
    expect(settingsBody(s).body?.breakthrough).toBe(true)
    expect(settingsBody({ ...s, breakthrough: false }).body?.breakthrough).toBe(false)
  })

  it('keeps the translation language in the PUT body and checks it like the server', () => {
    const s = { vip: [], keywords: [], quiet: { enabled: false, start: '22:00', end: '08:00' }, translate_to: 'fa' }
    expect(settingsBody(s).body?.translate_to).toBe('fa')
    expect(settingsBody({ ...s, translate_to: cleanLang(' IT ') }).body?.translate_to).toBe('it')
    for (const bad of ['', 'e', 'eng', 'EN', 'e1']) {
      expect(settingsBody({ ...s, translate_to: bad })).toEqual({
        body: null,
        error: 'Translate to needs a two-letter language code, for example en.',
      })
    }
    expect(TRANSLATE_LANGS.map(l => l.code)).toEqual(['en', 'es', 'fa', 'ru', 'ar', 'tr', 'de', 'fr', 'zh', 'pt', 'uk', 'hi'])
  })

  it('builds the PUT body, or explains a missing time', () => {
    const s = { vip: ['dana'], keywords: ['urgent'], quiet: { enabled: false, start: '22:00', end: '08:00' } }
    expect(settingsBody(s)).toEqual({ body: s, error: null })
    expect(settingsBody({ ...s, quiet: { enabled: true, start: '', end: '08:00' } })).toEqual({
      body: null,
      error: 'Quiet hours need a start and an end time.',
    })
  })
})
