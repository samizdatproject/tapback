export const DEFAULT_BACKEND = 'http://localhost:8787'

export type ChatKind = 'user' | 'group' | 'channel'
export interface InboxChat {
  id: string
  title: string
  kind: ChatKind
  unread: number
  /** "!" for a mention of me or an urgent keyword (the server sorts these first). */
  flag?: '!' | ''
}
export interface Chat extends InboxChat {
  picked: boolean
}
export interface Totals {
  unread: number
  chats: number
}
export interface Inbox {
  chats: InboxChat[]
  totals: Totals
}

export interface CardMsg {
  id: number
  sender: string
  time: string
  text: string
  mine: boolean
}
export interface Card {
  chat: { id: string; title: string; kind: ChatKind }
  /** Oldest → newest, at most 3. */
  msgs: CardMsg[]
  replyTo: { id: number; sender: string; text: string } | null
  suggestions: string[]
  /** Unread count before the card was shown. */
  newCount: number
  /** Unread messages not shown (read by Telegram's high-water mark once this card is shown). */
  earlier: number
  /** Send back in card_shown once the card is on the glasses; null when there is nothing to mark read. */
  readMaxId: number | null
}
export type SentMsg = { clientMsgId: string } & ({ ok: true; at: string } | { ok: false; human: string })
/** Speech-to-text result; empty `text` comes with a `human` reason. */
export interface SttMsg {
  /** Echo of the audio_begin id, so a late result can't land in a newer dictation. */
  id: string
  text: string
  human: string
}
export interface DigestPost {
  id: number
  text: string
  views: number
  reactions: number
}
export interface Sponsored {
  randomId: string
  label: string
  title: string
  text: string
  button: string
  sponsorInfo: string
  additionalInfo: string
}
export interface DigestChannel {
  id: string
  title: string
  newCount: number
  /** Nothing new: `top` holds the best of the last 24 h instead. */
  recent: boolean
  top: DigestPost[]
  /** Highest new post id, for digest_done; null when there is nothing to mark read. */
  maxId: number | null
  sponsored: Sponsored | null
}
export interface ServerError {
  code: string
  human: string
  /** The request type this error answers, and its chat or channel. */
  for?: string
  chatId?: string
}

/** Server → client. New members also need a case in parseServerMsg. */
export type ServerMsg =
  | ({ type: 'inbox' } & Inbox)
  | ({ type: 'card' } & Card)
  | ({ type: 'sent' } & SentMsg)
  | ({ type: 'stt' } & SttMsg)
  | { type: 'digest'; channels: DigestChannel[] }
  | ({ type: 'error' } & ServerError)
/** Client → server. */
export type ClientMsg =
  | { type: 'hello'; token: string }
  | { type: 'open_inbox' }
  | { type: 'open_chat'; chatId: string }
  | { type: 'send'; chatId: string; replyTo: number | null; text?: string; reaction?: string; clientMsgId: string }
  | { type: 'mute'; chatId: string; minutes: number }
  | { type: 'snooze'; chatId: string; minutes: number }
  | { type: 'audio_begin'; id: string }
  | { type: 'audio_end' }
  | { type: 'audio_cancel' }
  | { type: 'digest_open' }
  | { type: 'digest_done'; channelId: string; maxId: number }
  | { type: 'card_shown'; chatId: string; maxId: number }
  | { type: 'sponsored_viewed'; randomId: string }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

function parseChat(raw: unknown): InboxChat | null {
  const c = rec(raw)
  if (!c || c.id === undefined || c.id === null) return null
  const kind = c.kind === 'group' || c.kind === 'channel' ? c.kind : 'user'
  const chat: InboxChat = { id: String(c.id), title: str(c.title), kind, unread: num(c.unread) }
  if (c.flag === '!') chat.flag = '!'
  return chat
}

function parseCard(msg: Record<string, unknown>): Card | null {
  const chat = parseChat(msg.chat)
  if (!chat) return null
  const msgs = (Array.isArray(msg.msgs) ? msg.msgs : []).flatMap((raw): CardMsg[] => {
    const m = rec(raw)
    return m ? [{ id: num(m.id), sender: str(m.sender), time: str(m.time), text: str(m.text), mine: m.mine === true }] : []
  })
  const r = rec(msg.replyTo)
  return {
    chat: { id: chat.id, title: chat.title, kind: chat.kind },
    msgs,
    replyTo: r ? { id: num(r.id), sender: str(r.sender), text: str(r.text) } : null,
    suggestions: Array.isArray(msg.suggestions) ? msg.suggestions.map(s => str(s)).filter(Boolean) : [],
    newCount: num(msg.newCount),
    earlier: num(msg.earlier),
    readMaxId: typeof msg.readMaxId === 'number' && Number.isInteger(msg.readMaxId) ? msg.readMaxId : null,
  }
}

function parseChannel(raw: unknown): DigestChannel[] {
  const c = rec(raw)
  if (!c || c.id == null) return []
  const s = rec(c.sponsored)
  return [
    {
      id: String(c.id),
      title: str(c.title),
      newCount: num(c.newCount),
      recent: c.recent === true,
      top: (Array.isArray(c.top) ? c.top : []).flatMap((p): DigestPost[] => {
        const r = rec(p)
        return r ? [{ id: num(r.id), text: str(r.text), views: num(r.views), reactions: num(r.reactions) }] : []
      }),
      maxId: typeof c.maxId === 'number' && Number.isInteger(c.maxId) ? c.maxId : null,
      sponsored:
        s && s.randomId
          ? {
              randomId: str(s.randomId),
              label: str(s.label, 'Sponsored'),
              title: str(s.title),
              text: str(s.text),
              button: str(s.button),
              sponsorInfo: str(s.sponsorInfo),
              additionalInfo: str(s.additionalInfo),
            }
          : null,
    },
  ]
}

/** Pure: a WebSocket text frame in, a typed message (or null to ignore) out. */
export function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null // binary frames are not used yet
  let msg: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) return null
    msg = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (msg.type) {
    case 'inbox': {
      const chats = Array.isArray(msg.chats)
        ? msg.chats.map(parseChat).filter((c): c is InboxChat => c !== null)
        : []
      const t = (msg.totals ?? {}) as Record<string, unknown>
      return { type: 'inbox', chats, totals: { unread: num(t.unread), chats: num(t.chats) } }
    }
    case 'card': {
      const card = parseCard(msg)
      return card && { type: 'card', ...card }
    }
    case 'sent': {
      const clientMsgId = str(msg.clientMsgId)
      if (!clientMsgId) return null
      return msg.ok === true
        ? { type: 'sent', clientMsgId, ok: true, at: str(msg.at) }
        : { type: 'sent', clientMsgId, ok: false, human: str(msg.human, 'Not sent') }
    }
    case 'stt':
      return { type: 'stt', id: str(msg.id), text: str(msg.text).trim(), human: str(msg.human, "Didn't catch that") }
    case 'digest':
      return { type: 'digest', channels: (Array.isArray(msg.channels) ? msg.channels : []).flatMap(parseChannel) }
    case 'error': {
      const err: ServerError = { code: str(msg.code), human: str(msg.human, 'Server error') }
      if (typeof msg.for === 'string') err.for = msg.for
      if (msg.chatId != null && msg.chatId !== '') err.chatId = String(msg.chatId)
      return { type: 'error', ...err }
    }
    default:
      return null
  }
}

/** Reconnect delay for the n-th consecutive failure (0-based): 1, 2, 4, 8, 16, 30, 30… s. */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
}

/** Trims and validates a backend base URL; throws on anything not http(s). */
export function normaliseBase(input: string): string {
  const url = new URL(input.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http:// or https:// URL')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export function wsUrl(base: string): string {
  return base.replace(/^http/, 'ws') + '/ws'
}

// ---- HTTP ----

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(
  base: string,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let res: Response
  try {
    res = await fetch(base + path, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    })
  } catch {
    throw new HttpError(0, `Can't reach the TapBack server at ${base}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    // FastAPI puts the reason in `detail`; show it when it is plain text.
    const detail = await res.json().then(
      (b: unknown) => (typeof rec(b)?.detail === 'string' ? (rec(b)?.detail as string) : ''),
      () => '',
    )
    throw new HttpError(res.status, detail || `Server said ${res.status} ${res.statusText}`.trim())
  }
  return (await res.json()) as T
}

export const api = {
  healthz: (base: string) => request<{ ok: boolean; tagline: string }>(base, '/healthz'),
  pair: (base: string, code: string) =>
    request<{ token: string }>(base, '/pair', { method: 'POST', body: { code } }),
  chats: (base: string, token: string) => request<{ chats: Chat[] }>(base, '/chats', { token }),
  putPicked: (base: string, token: string, chatIds: string[]) =>
    request<{ ok: boolean }>(base, '/picked', { method: 'PUT', token, body: { chatIds } }),
  /** Signs the server out of Telegram and wipes its session. */
  logout: (base: string, token: string) => request<{ ok: boolean }>(base, '/logout', { method: 'POST', token }),
}

// ---- WebSocket ----

export type LinkStatus = 'connecting' | 'online' | 'offline'

export interface LinkHandlers {
  message(msg: ServerMsg): void
  status(status: LinkStatus): void
  /** The server revoked this device (close code 4401): stop and pair again. */
  unpaired(): void
}

const CLOSE_UNPAIRED = 4401

/**
 * One live connection to the backend. Every (re)connect sends `hello`, and the
 * server answers with a fresh inbox, so state is fully resynced each time.
 */
export class Link {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private online = false
  private gen = 0 // bumps on every socket; stale sockets' events are ignored

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly on: LinkHandlers,
  ) {}

  start(): void {
    this.stop()
    this.open()
  }

  stop(): void {
    this.gen++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ws?.close()
    this.ws = null
  }

  send(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Binary frame: raw PCM for a dictation in progress. */
  sendBinary(bytes: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(bytes)
    return true
  }

  private open(): void {
    const gen = ++this.gen
    this.online = false
    if (this.attempt === 0) this.on.status('connecting') // retries stay 'offline'
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      console.warn('[tapback] websocket', err)
      this.retry(gen)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (gen === this.gen) this.send({ type: 'hello', token: this.token })
    }
    ws.onmessage = ev => {
      if (gen !== this.gen) return
      const msg = parseServerMsg(ev.data)
      if (!msg) return
      // Only a real reply proves the token works; an error-then-close keeps backing off.
      if (msg.type !== 'error' && !this.online) {
        this.online = true
        this.attempt = 0
        this.on.status('online')
      }
      this.on.message(msg)
    }
    ws.onclose = ev => {
      if (gen === this.gen && ev.code === CLOSE_UNPAIRED) {
        this.stop()
        this.on.unpaired()
        return
      }
      this.retry(gen)
    }
  }

  private retry(gen: number): void {
    if (gen !== this.gen) return
    this.gen++
    this.ws = null
    this.on.status('offline')
    const delay = backoffDelay(this.attempt++)
    console.log(`[tapback] offline, retrying in ${delay} ms`)
    this.timer = setTimeout(() => this.open(), delay)
  }
}
