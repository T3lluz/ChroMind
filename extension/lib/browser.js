/**
 * One extension API for Firefox and Chromium. Firefox exposes promise-based
 * `browser`, Chromium exposes `chrome` (promise-based in MV3). Everything in
 * ChroMind goes through `api` and feature-detects the few calls that differ:
 * Chromium's side panel (`sidePanel`) versus Firefox's sidebar
 * (`sidebarAction`), and `contextMenus` versus `menus`.
 */
export const api = globalThis.browser ?? globalThis.chrome

// Optional chaining keeps these modules importable in Node tests.
export const isFirefox = !!api?.runtime?.getURL?.('').startsWith('moz-extension:')

export const menus = api?.menus ?? api?.contextMenus

export const version = api?.runtime?.getManifest?.().version ?? '0.0.0'

/**
 * Opens the side panel (Chromium) or sidebar (Firefox) for WINDOWID/TABID.
 * Both browsers only allow this inside a user gesture, and the gesture is
 * lost at the first `await`, so call it synchronously at the top of the
 * click, command or menu handler. Returns a promise that settles when the
 * browser has answered; it never throws.
 */
export function openPanel({ tabId, windowId } = {}) {
  try {
    if (api.sidebarAction?.open) return api.sidebarAction.open().then(() => true, () => false)
    if (api.sidePanel?.open) {
      const target = typeof windowId === 'number' ? { windowId } : { tabId }
      return api.sidePanel.open(target).then(() => true, () => false)
    }
  } catch {
    // Called outside a gesture: the caller falls back to a hint.
  }
  return Promise.resolve(false)
}

/** Opens the full settings page, at #SECTION when given. */
export function openOptions(section = '') {
  const url = api.runtime.getURL(`options/options.html${section ? '#' + section : ''}`)
  return api.tabs.create({ url })
}

export function uid() {
  return crypto.randomUUID()
}
