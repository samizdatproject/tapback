import { INTRO_TEXT } from './format'
import type { Page } from './manager'

/** Root page until the phone screen has paired with a backend. */
export function introPage(): Page {
  return {
    id: 'intro',
    texts: [{ name: 'intro', x: 0, y: 0, w: 576, h: 288, content: INTRO_TEXT, capture: true }],
  }
}
