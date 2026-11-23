export const DEFAULT_BACKEND = 'http://localhost:8787'

export type ChatKind = 'user' | 'group' | 'channel'
export interface InboxChat {
  id: string
  title: string
  kind: ChatKind
  unread: number
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

/** Server → client. Day 2+ adds members here and a case in parseServerMsg. */
export type ServerMsg = ({ type: 'inbox' } & Inbox) | { type: 'error'; code: string; human: string }
/** Client → server. */
export type ClientMsg = { type: 'hello'; token: string } | { type: 'open_inbox' }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function parseChat(raw: unknown): InboxChat | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (c.id === undefined || c.id === null) return null
  const kind = c.kind === 'group' || c.kind === 'channel' ? c.kind : 'user'
  return { id: String(c.id), title: String(c.title ?? ''), kind, unread: num(c.unread) }
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
    case 'error':
      return { type: 'error', code: String(msg.code ?? ''), human: String(msg.human ?? 'Server error') }
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
  if (!res.ok) throw new HttpError(res.status, `Server said ${res.status} ${res.statusText}`.trim())
  return (await res.json()) as T
}

export const api = {
  healthz: (base: string) => request<{ ok: boolean; tagline: string }>(base, '/healthz'),
  pair: (base: string, code: string) =>
    request<{ token: string }>(base, '/pair', { method: 'POST', body: { code } }),
  chats: (base: string, token: string) => request<{ chats: Chat[] }>(base, '/chats', { token }),
  putPicked: (base: string, token: string, chatIds: string[]) =>
    request<{ ok: boolean }>(base, '/picked', { method: 'PUT', token, body: { chatIds } }),
}

// ---- WebSocket ----

export type LinkStatus = 'connecting' | 'online' | 'offline'

export interface LinkHandlers {
  message(msg: ServerMsg): void
  status(status: LinkStatus): void
}

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
    ws.onclose = () => this.retry(gen)
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
