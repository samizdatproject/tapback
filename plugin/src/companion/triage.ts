import type { Settings } from '../net'
import { el, message } from './dom'
import { DEFAULT_KEYWORDS, addItem, removeItem, settingsBody } from './settings'

export interface TriageActions {
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
}

/** "Triage" card: VIP senders, urgent words, quiet hours. */
export function triageSection(actions: TriageActions): { element: HTMLElement; load(): Promise<void> } {
  let model: Settings | null = null

  const error = el('p', { className: 'error', role: 'alert', hidden: true })
  const saved = el('p', { className: 'hint', hidden: true })
  const showError = (text: string | null) => {
    error.textContent = text ?? ''
    error.hidden = !text
    if (text) saved.hidden = true
  }

  function listEditor(opts: { label: string; hint: string; placeholder: string; stripAt: boolean; key: 'vip' | 'keywords' }) {
    const chips = el('div', { className: 'chips' })
    const input = el('input', { type: 'text', placeholder: opts.placeholder, autocomplete: 'off', spellcheck: false })
    input.setAttribute('aria-label', `Add to ${opts.label}`)
    const add = el('button', { type: 'button' }, 'Add')
    const err = el('p', { className: 'error', role: 'alert', hidden: true }) // next to the field it is about
    const fieldError = (text: string | null) => {
      err.textContent = text ?? ''
      err.hidden = !text
    }
    const render = () => {
      chips.replaceChildren()
      const list = model?.[opts.key] ?? []
      if (list.length === 0) chips.append(el('span', { className: 'hint' }, 'None yet.'))
      for (const item of list) {
        const remove = el('button', { type: 'button', className: 'chip-x', textContent: '×' })
        remove.setAttribute('aria-label', `Remove ${item}`)
        remove.addEventListener('click', () => {
          if (!model) return
          model = { ...model, [opts.key]: removeItem(model[opts.key], item) }
          fieldError(null)
          render()
        })
        chips.append(el('span', { className: 'tag' }, el('span', { textContent: item }), remove))
      }
    }
    const doAdd = () => {
      if (!model) return
      const added = addItem(model[opts.key], input.value, opts.stripAt)
      fieldError(added.error)
      if (added.error) return
      const list = added.list
      model = { ...model, [opts.key]: list }
      input.value = ''
      render()
    }
    add.addEventListener('click', doAdd)
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        doAdd()
      }
    })
    const block = el(
      'div',
      { className: 'field' },
      el('h3', {}, opts.label),
      el('p', { className: 'hint' }, opts.hint),
      chips,
      el('div', { className: 'add' }, input, add),
      err,
    )
    return { block, render, fieldError }
  }

  const vip = listEditor({
    key: 'vip',
    label: 'VIP senders',
    hint: 'Names or @usernames. Their messages get ★ and come first.',
    placeholder: 'dana or @dana',
    stripAt: true,
  })
  const words = listEditor({
    key: 'keywords',
    label: 'Urgent words',
    hint: 'Whole words. End with * to match word starts (liquidat*).',
    placeholder: 'outage',
    stripAt: false,
  })
  const reset = el('button', { type: 'button', className: 'link' }, 'Reset to defaults')
  reset.addEventListener('click', () => {
    if (!model) return
    model = { ...model, keywords: [...DEFAULT_KEYWORDS] }
    words.fieldError(null)
    words.render()
  })
  words.block.append(reset)

  const quietOn = el('input', { type: 'checkbox', id: 'quiet-on' })
  const start = el('input', { type: 'time', id: 'quiet-start' })
  const end = el('input', { type: 'time', id: 'quiet-end' })
  const syncQuiet = () => {
    if (!model) return
    model = { ...model, quiet: { enabled: quietOn.checked, start: start.value, end: end.value } }
  }
  for (const input of [quietOn, start, end]) input.addEventListener('change', syncQuiet)
  const quiet = el(
    'div',
    { className: 'field' },
    el('h3', {}, 'Quiet hours'),
    el('p', { className: 'hint' }, 'Glasses show counts only; nothing moves on by itself.'),
    el('label', { className: 'toggle', htmlFor: 'quiet-on' }, quietOn, 'Quiet hours on'),
    el(
      'div',
      { className: 'times' },
      el('label', { htmlFor: 'quiet-start' }, 'From', start),
      el('label', { htmlFor: 'quiet-end' }, 'To', end),
    ),
  )

  const save = el('button', { type: 'button', className: 'primary' }, 'Save')
  const body = el('div', { className: 'stack', hidden: true }, vip.block, words.block, quiet, error, saved, el('div', { className: 'row' }, save))
  const status = el('p', { className: 'hint' }, 'Loading…')
  const element = el(
    'section',
    { className: 'card' },
    el('h2', {}, 'Triage'),
    el('p', { className: 'hint' }, 'What gets flagged on your glasses, and when they stay quiet.'),
    status,
    body,
  )

  function show(s: Settings) {
    model = { vip: [...s.vip], keywords: [...s.keywords], quiet: { ...s.quiet } }
    quietOn.checked = s.quiet.enabled
    start.value = s.quiet.start
    end.value = s.quiet.end
    vip.render()
    words.render()
    status.hidden = true
    body.hidden = false
  }

  save.addEventListener('click', async () => {
    if (!model) return
    syncQuiet()
    const { body: payload, error: err } = settingsBody(model)
    showError(err)
    if (!payload) return
    save.disabled = true
    try {
      show(await actions.saveSettings(payload))
      saved.textContent = 'Saved.'
      saved.hidden = false
    } catch (e) {
      showError(message(e)) // the server's 400 detail, e.g. a word that is too long
    } finally {
      save.disabled = false
    }
  })

  async function load() {
    status.textContent = 'Loading…'
    status.hidden = false
    body.hidden = true
    showError(null)
    vip.fieldError(null)
    words.fieldError(null)
    saved.hidden = true
    try {
      show(await actions.loadSettings())
    } catch (e) {
      status.textContent = `Couldn't load the triage settings. ${message(e)}`
      throw e
    }
  }

  return { element, load }
}
