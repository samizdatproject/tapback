import type { Settings } from '../net'

// Mirrors the server's rules so most mistakes show up before Save; the server
// still has the last word (its 400 detail is shown inline).
export const DEFAULT_KEYWORDS = ['urgent', 'asap', 'now', 'today', 'call me', 'deadline', 'down', 'failed', 'liquidat*']
export const MAX_ITEMS = 30
export const MAX_LEN = 40
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const LANG = /^[a-z]{2}$/ // ISO 639-1, as the server checks it

/** Offered in the "Translate to" select; any other two-letter code goes in "Other". */
export const TRANSLATE_LANGS: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fa', name: 'Persian' },
  { code: 'ru', name: 'Russian' },
  { code: 'ar', name: 'Arabic' },
  { code: 'tr', name: 'Turkish' },
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
  { code: 'zh', name: 'Chinese' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'hi', name: 'Hindi' },
]

/** Lowercase, single spaces, and for VIPs no leading @ (as the server stores them). */
export function cleanItem(raw: string, stripAt = false): string {
  const s = raw.replace(/\s+/g, ' ').trim().toLowerCase()
  return stripAt ? s.replace(/^@+/, '') : s
}

/** Adds one item; on a problem returns the list unchanged and a message to show. */
export function addItem(list: string[], raw: string, stripAt = false): { list: string[]; error: string | null } {
  const item = cleanItem(raw, stripAt)
  if (!item) return { list, error: 'Type a name or word first.' }
  if (item.length > MAX_LEN) return { list, error: `Keep it under ${MAX_LEN} characters.` }
  if (list.includes(item)) return { list, error: `"${item}" is already on the list.` }
  if (list.length >= MAX_ITEMS) return { list, error: `At most ${MAX_ITEMS} items.` }
  return { list: [...list, item], error: null }
}

export function removeItem(list: string[], item: string): string[] {
  return list.filter(x => x !== item)
}

export function validTime(value: string): boolean {
  return TIME.test(value)
}

/** A typed language code, trimmed and lowercased ("ES " → "es"). */
export function cleanLang(raw: string): string {
  return raw.trim().toLowerCase()
}

/** The body for PUT /settings, or a message if the form is not valid yet. */
export function settingsBody(s: Settings): { body: Settings | null; error: string | null } {
  if (!validTime(s.quiet.start) || !validTime(s.quiet.end)) {
    return { body: null, error: 'Quiet hours need a start and an end time.' }
  }
  if (s.translate_to !== undefined && !LANG.test(s.translate_to)) {
    return { body: null, error: 'Translate to needs a two-letter language code, for example en.' }
  }
  const body: Settings = { vip: [...s.vip], keywords: [...s.keywords], quiet: { ...s.quiet } }
  if (s.breakthrough !== undefined) body.breakthrough = s.breakthrough
  if (s.translate_to !== undefined) body.translate_to = s.translate_to
  return { body, error: null }
}
