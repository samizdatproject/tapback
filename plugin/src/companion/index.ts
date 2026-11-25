import { HttpError, type Chat, type ChatKind } from '../net'
import type { State, Store } from '../state'
import { el, message } from './dom'
import { triageSection, type TriageActions } from './triage'
import './style.css'

export interface CompanionActions extends TriageActions {
  pair(base: string, code: string): Promise<void>
  unpair(): Promise<void>
  /** Log the server out of Telegram and wipe its session. */
  logout(): Promise<void>
  loadChats(): Promise<Chat[]>
  savePicked(chatIds: string[]): Promise<void>
}

const GROUPS: { kind: ChatKind; label: string }[] = [
  { kind: 'user', label: 'People' },
  { kind: 'group', label: 'Groups' },
  { kind: 'channel', label: 'Channels' },
]

const LINK_LABEL = { online: 'Online', connecting: 'Connecting…', offline: 'Offline · retrying' }

/** The phone screen: pairing, chat picker, status. Chat titles only ever go in via textContent. */
export function mountCompanion(root: HTMLElement, store: Store, actions: CompanionActions): void {
  const status = el('p', { className: 'status', role: 'status' })
  const chip = el('span', { className: 'chip' })

  // Pair form
  const baseInput = el('input', {
    type: 'url',
    id: 'base',
    autocomplete: 'off',
    spellcheck: false,
    value: store.get().base,
  })
  const codeInput = el('input', {
    type: 'text',
    id: 'code',
    inputMode: 'numeric',
    autocomplete: 'one-time-code',
    maxLength: 6,
    pattern: '[0-9]{6}',
    placeholder: '123456',
  })
  const pairButton = el('button', { type: 'submit', className: 'primary' }, 'Pair')
  const pairForm = el(
    'form',
    { className: 'card' },
    el('h2', {}, 'Pair'),
    el('p', { className: 'hint' }, 'Start the TapBack backend, then type the 6-digit code it prints.'),
    el('label', { htmlFor: 'base' }, 'Backend URL'),
    baseInput,
    el('label', { htmlFor: 'code' }, 'Pairing code'),
    codeInput,
    pairButton,
  )

  // Paired view
  const pairedWith = el('p', { className: 'hint' })
  const chatList = el('div', { className: 'chats' })
  const reloadButton = el('button', { type: 'button' }, 'Reload')
  const saveButton = el('button', { type: 'button', className: 'primary' }, 'Save')
  const unpairButton = el('button', { type: 'button', className: 'danger' }, 'Unpair')
  const logoutButton = el('button', { type: 'button', className: 'danger' }, 'Log out & wipe')
  const logoutHint = el('p', { className: 'hint', hidden: true })
  const pickCard = el(
    'section',
    { className: 'card' },
    el('h2', {}, 'Pick chats'),
    el('p', { className: 'hint' }, 'Only these chats show up on your glasses, unless you turn on breakthrough under Triage.'),
    chatList,
    el('div', { className: 'row' }, reloadButton, saveButton),
  )
  const deviceCard = el(
    'section',
    { className: 'card' },
    el('h2', {}, 'This device'),
    pairedWith,
    el('div', { className: 'row start' }, unpairButton, logoutButton),
    logoutHint,
  )
  const triage = triageSection(actions)
  const pairedView = el('div', { className: 'stack' }, pickCard, triage.element, deviceCard)
  const privacy = el(
    'section',
    { className: 'card' },
    el('h2', {}, 'Privacy'),
    el(
      'ul',
      { className: 'privacy' },
      ...[
        'TapBack is an unofficial Telegram client. It uses the Telegram API.',
        'Only chats you pick reach the glasses, plus breakthrough chats if you turn that on. Opening a card marks it read.',
        'Reply suggestions come from fixed rules. No message is sent to any AI service.',
        "Dictation audio goes only to your own server's speech-to-text.",
        'Sponsored messages in channels are shown as Telegram requires.',
        'Your server keeps no message text; the Telegram session is stored encrypted.',
      ].map(line => el('li', {}, line)),
    ),
  )

  root.replaceChildren(
    el(
      'main',
      { className: 'panel' },
      el(
        'header',
        {},
        el('div', {}, el('h1', {}, 'TapBack'), el('p', { className: 'tagline' }, 'Only the chats you pick, one card at a time.')),
        chip,
      ),
      el('p', { className: 'legal' }, 'Unofficial Telegram client · uses the Telegram API'),
      status,
      pairForm,
      pairedView,
      privacy,
    ),
  )

  const say = (text: string) => store.set({ notice: text })

  async function busy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    button.disabled = true
    try {
      await work()
    } catch (err) {
      say(message(err))
    } finally {
      button.disabled = false
    }
  }

  function renderChats(chats: Chat[]): void {
    chatList.replaceChildren()
    if (chats.length === 0) {
      chatList.append(el('p', { className: 'hint' }, 'No chats found on this Telegram account.'))
      return
    }
    for (const group of GROUPS) {
      const items = chats.filter(c => c.kind === group.kind)
      if (items.length === 0) continue
      const list = el('ul')
      for (const chat of items) {
        const box = el('input', { type: 'checkbox', checked: chat.picked, value: chat.id })
        const title = el('span', { className: 'title', textContent: chat.title || 'Untitled chat' })
        const label = el('label', {}, box, title)
        if (chat.unread > 0) label.append(el('span', { className: 'badge', textContent: String(chat.unread) }))
        list.append(el('li', {}, label))
      }
      chatList.append(el('h3', {}, group.label), list)
    }
  }

  let chats: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle'
  async function loadChats(): Promise<void> {
    chats = 'loading'
    chatList.replaceChildren(el('p', { className: 'hint' }, 'Loading chats…'))
    try {
      renderChats(await actions.loadChats())
      chats = 'loaded'
    } catch (err) {
      chats = 'failed'
      chatList.replaceChildren(el('p', { className: 'hint' }, "Couldn't load chats. Reload when the server is back."))
      throw err
    }
  }

  pairForm.addEventListener('submit', ev => {
    ev.preventDefault()
    const code = codeInput.value.trim()
    if (!/^\d{6}$/.test(code)) {
      say('The pairing code is 6 digits.')
      return
    }
    void busy(pairButton, async () => {
      say('Pairing…')
      try {
        await actions.pair(baseInput.value, code)
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) throw new Error('Wrong or expired code. Get a new one from the backend.')
        throw err
      }
      codeInput.value = ''
    })
  })

  reloadButton.addEventListener('click', () => void busy(reloadButton, loadChats))

  saveButton.addEventListener('click', () =>
    void busy(saveButton, async () => {
      const ids = Array.from(chatList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'), b => b.value)
      await actions.savePicked(ids)
      say(`Saved. ${ids.length} chat${ids.length === 1 ? '' : 's'} on your glasses.`)
    }),
  )

  unpairButton.addEventListener('click', () => void busy(unpairButton, actions.unpair))

  // Destructive: the first tap only arms it for 5 s.
  let armed: ReturnType<typeof setTimeout> | null = null
  const disarm = () => {
    if (armed) clearTimeout(armed)
    armed = null
    logoutHint.hidden = true
    logoutButton.textContent = 'Log out & wipe'
  }
  logoutButton.addEventListener('click', () => {
    if (!armed) {
      logoutHint.textContent = 'This signs TapBack out of Telegram on the server and deletes the session. Tap again to confirm'
      logoutHint.hidden = false
      logoutButton.textContent = 'Tap again to confirm'
      armed = setTimeout(disarm, 5000)
      return
    }
    disarm()
    void busy(logoutButton, async () => {
      say('Logging out…')
      await actions.logout()
    })
  })

  let wasPaired: boolean | null = null
  let wasOnline: boolean | null = null
  let shownBase = ''
  function render(state: State): void {
    const paired = state.token !== null
    pairForm.hidden = paired
    pairedView.hidden = !paired
    chip.hidden = !paired
    chip.textContent = LINK_LABEL[state.link]
    chip.className = `chip chip-${state.link}`
    status.textContent = state.notice
    pairedWith.textContent = `Paired with ${state.base}`
    if (state.base !== shownBase) baseInput.value = shownBase = state.base
    // Load on pairing, and again once the server is back if that failed.
    const retry = state.link === 'online' && wasOnline === false && chats === 'failed'
    if (paired && (wasPaired !== true || retry)) {
      void loadChats().catch(err => say(message(err)))
      void triage.load().catch(() => {}) // the section shows its own error
    }
    wasPaired = paired
    wasOnline = state.link === 'online'
  }

  store.subscribe(render)
  render(store.get())
}
