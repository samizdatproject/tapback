import { connectBridge, type Input } from './bridge'
import { mountCompanion } from './companion'
import {
  DEFAULT_BACKEND,
  HttpError,
  Link,
  api,
  normaliseBase,
  wsUrl,
  type ServerMsg,
} from './net'
import { Glasses } from './screens'
import { MENU_REFRESH } from './screens/inbox'
import { ScreenManager } from './screens/manager'
import { createStore } from './state'
import { KEY_BACKEND, KEY_TOKEN, load, save, useBridgeStorage } from './storage'

const store = createStore({ token: null, base: DEFAULT_BACKEND, link: 'offline', inbox: null, notice: '' })
let link: Link | null = null
let glasses: Glasses | null = null

// One handler per server message type; day 2+ adds `card`, `sent`, … here.
const onServer: { [K in ServerMsg['type']]: (msg: Extract<ServerMsg, { type: K }>) => void } = {
  inbox: msg => store.set({ inbox: { chats: msg.chats, totals: msg.totals } }),
  error: msg => store.set({ notice: msg.human }),
}

function startLink(): void {
  link?.stop()
  link = null
  const { token, base } = store.get()
  if (!token) return
  link = new Link(wsUrl(base), token, {
    message: msg => (onServer[msg.type] as (m: ServerMsg) => void)(msg),
    status: s => store.set({ link: s }),
  })
  link.start()
}

async function unpair(notice: string): Promise<void> {
  link?.stop()
  link = null
  await save(KEY_TOKEN, null)
  store.set({ token: null, inbox: null, link: 'offline', notice })
}

/** Runs an authenticated call; a 401 means the token is gone, so drop back to pairing. */
async function authed<T>(call: (base: string, token: string) => Promise<T>): Promise<T> {
  const { base, token } = store.get()
  if (!token) throw new Error('Not paired.')
  try {
    return await call(base, token)
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      await unpair('This device is no longer paired. Pair again.')
    }
    throw err
  }
}

function onInput(input: Input): void {
  switch (input.kind) {
    case 'DOUBLE':
      glasses?.exit() // Intro and Inbox are both root pages
      break
    case 'LIST_SELECT': {
      const chat = glasses?.chatAt(input.index)
      console.log('[tapback] chat selected (opens a card from day 2)', input.index, chat?.id)
      break
    }
    case 'MENU':
      if (input.itemId === MENU_REFRESH) {
        glasses?.refresh(store.get())
        link?.send({ type: 'open_inbox' })
      }
      break
    case 'EXIT':
      link?.stop()
      break
    default:
      break // taps, swipes, long press, foreground changes, audio: nothing on day 1
  }
}

mountCompanion(document.querySelector<HTMLElement>('#app')!, store, {
  async pair(baseInput, code) {
    const base = normaliseBase(baseInput)
    const { token } = await api.pair(base, code)
    if (!token) throw new Error('The server sent no token.')
    await save(KEY_BACKEND, base)
    await save(KEY_TOKEN, token)
    store.set({ token, base, inbox: null, notice: 'Paired.' })
    startLink()
  },
  unpair: () => unpair('Unpaired. This device no longer has a token.'),
  loadChats: async () => (await authed(api.chats)).chats,
  async savePicked(chatIds) {
    await authed((base, token) => api.putPicked(base, token, chatIds))
    glasses?.refresh(store.get())
    link?.send({ type: 'open_inbox' })
  },
})

const bridge = await connectBridge(onInput)
useBridgeStorage(bridge)
const [token, base] = await Promise.all([load(KEY_TOKEN), load(KEY_BACKEND)])
store.set({ token, base: base ?? DEFAULT_BACKEND })

if (bridge) {
  glasses = new Glasses(new ScreenManager(bridge, notice => store.set({ notice })))
  const g = glasses
  g.render(store.get())
  store.subscribe(s => g.render(s))
} else {
  store.set({ notice: 'No glasses connected: phone screen only.' })
}
startLink()
window.addEventListener('beforeunload', () => link?.stop())
