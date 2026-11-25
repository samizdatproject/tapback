import { AudioInputSource } from '@evenrealities/even_hub_sdk'
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
import { ScreenManager } from './screens/manager'
import { createStore } from './state'
import { KEY_BACKEND, KEY_TOKEN, load, save, useBridgeStorage } from './storage'

const store = createStore({ token: null, base: DEFAULT_BACKEND, link: 'offline', inbox: null, notice: '' })
let link: Link | null = null
let glasses: Glasses | null = null

// One handler per server message type.
const onServer: { [K in ServerMsg['type']]: (msg: Extract<ServerMsg, { type: K }>) => void } = {
  inbox: ({ type: _, ...inbox }) => store.set({ inbox }),
  card: ({ type: _, ...card }) => glasses?.onCard(card),
  sent: ({ type: _, ...sent }) => glasses?.onSent(sent),
  stt: ({ type: _, ...stt }) => glasses?.onStt(stt),
  digest: msg => glasses?.onDigest(msg.channels),
  later: () => {}, // the glasses moved on already; a failure arrives as an error
  translation: ({ type: _, ...translation }) => glasses?.onTranslation(translation),
  error: ({ type: _, ...err }) => {
    if (err.code === 'unpaired') {
      void unpair(SIGNED_OUT)
      return
    }
    store.set({ notice: err.human })
    glasses?.onError(err)
  },
}

const SIGNED_OUT = 'The server signed this device out. Pair again.'

function startLink(): void {
  link?.stop()
  link = null
  const { token, base } = store.get()
  if (!token) return
  link = new Link(wsUrl(base), token, {
    message: msg => (onServer[msg.type] as (m: ServerMsg) => void)(msg),
    status: s => store.set({ link: s }),
    unpaired: () => void unpair(SIGNED_OUT),
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
  if (input.kind === 'EXIT') link?.stop()
  glasses?.input(input)
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
  async logout() {
    try {
      await authed(api.logout)
      await unpair('Logged out. The server has stopped; run tapback login to use it again.')
    } catch (err) {
      // 502: Telegram's logout failed, but the server still wiped its session and devices.
      if (err instanceof HttpError && err.status === 502) await unpair(err.message)
      else throw err
    }
  },
  loadSettings: () => authed(api.getSettings),
  saveSettings: async settings => {
    const { ok: _, ...saved } = await authed((base, token) => api.putSettings(base, token, settings))
    return saved
  },
  async savePicked(chatIds) {
    await authed((base, token) => api.putPicked(base, token, chatIds))
    glasses?.refresh()
    link?.send({ type: 'open_inbox' })
  },
})

const bridge = await connectBridge(onInput)
useBridgeStorage(bridge)
const [token, base] = await Promise.all([load(KEY_TOKEN), load(KEY_BACKEND)])
store.set({ token, base: base ?? DEFAULT_BACKEND })

if (bridge) {
  const b = bridge
  glasses = new Glasses(new ScreenManager(b, notice => store.set({ notice })), {
    send: msg => link?.send(msg) ?? false,
    sendAudio: pcm => link?.sendBinary(pcm) ?? false,
    async mic(on) {
      if (!on) return b.audioControl(false).catch(() => false)
      // Glasses mic first; the phone mic if the glasses can't (or in some hosts).
      for (const source of [AudioInputSource.Glasses, AudioInputSource.Phone]) {
        try {
          if (await b.audioControl(true, source)) {
            console.log('[tapback] mic on:', source)
            return true
          }
        } catch (err) {
          console.warn('[tapback] audioControl failed', source, err)
        }
      }
      return false
    },
  })
  const g = glasses
  g.render(store.get())
  store.subscribe(s => g.render(s))
} else {
  store.set({ notice: 'No glasses connected: phone screen only.' })
}
startLink()
window.addEventListener('beforeunload', () => {
  glasses?.input({ kind: 'EXIT' }) // turns the mic off if a dictation is running
  link?.stop()
})
