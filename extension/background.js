/**
 * ChroMind background: service worker in Chromium, event page in Firefox.
 *
 * - Right-click menus, keyboard commands and the toolbar button open the
 *   side panel (sidebar in Firefox) and hand it a request.
 * - Answers for the selection toolbar's inline card stream from here, over
 *   a port named "inline".
 * - Header rules for claude.ai and self-hosted servers (lib/net-rules.js).
 *
 * The side panel itself runs chats in its own page, so a long answer never
 * depends on the service worker staying alive.
 */
import { api, isFirefox, menus, openOptions, openPanel } from './lib/browser.js'
import { saveThread, newThread } from './lib/history.js'
import { installNetRules } from './lib/net-rules.js'
import { actionPrompt, actionsFor, findAction, threadTitle } from './lib/prompts.js'
import { providerLabel, runChat } from './lib/providers/index.js'
import { serializeError } from './lib/providers/errors.js'
import { getSettings, onSettingsChanged } from './lib/settings.js'

installNetRules()

/* ---------- side panel hand-off ---------- */

/** Open side panel ports by window id. */
const panels = new Map()
/** Requests waiting for a panel to open, by window id. */
const pending = new Map()

async function deliver(windowId, request) {
  const port = panels.get(windowId)
  if (port) {
    try {
      port.postMessage({ type: 'request', request })
      return
    } catch {
      panels.delete(windowId)
    }
  }
  pending.set(windowId, request)
  // The service worker can restart before the panel connects.
  await api.storage.session?.set({ [`pending:${windowId}`]: request }).catch(() => {})
}

async function takePending(windowId) {
  let request = pending.get(windowId)
  pending.delete(windowId)
  const key = `pending:${windowId}`
  if (api.storage.session) {
    const stored = await api.storage.session.get(key).catch(() => ({}))
    request ??= stored[key]
    await api.storage.session.remove(key).catch(() => {})
  }
  return request ?? null
}

api.runtime.onConnect.addListener((port) => {
  if (port.name === 'panel') {
    let windowId = null
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'hello') {
        windowId = msg.windowId
        panels.set(windowId, port)
        const request = await takePending(windowId)
        if (request) port.postMessage({ type: 'request', request })
      }
    })
    port.onDisconnect.addListener(() => {
      if (panels.get(windowId) === port) panels.delete(windowId)
    })
  } else if (port.name === 'inline') {
    handleInline(port)
  }
})

/* ---------- toolbar button and keyboard ---------- */

if (isFirefox) {
  // Firefox: the button toggles the sidebar (no popup is set).
  api.action.onClicked.addListener(() => api.sidebarAction.toggle())
} else {
  api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
}

api.commands.onCommand.addListener(async (command, tab) => {
  const scope = command === 'summarize-page' ? 'page' : command === 'explain-selection' ? 'selection' : null
  if (!scope) return
  openPanel({ tabId: tab?.id, windowId: tab?.windowId })
  const target = tab ?? (await api.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  if (!target) return
  deliver(target.windowId, {
    scope,
    actionId: scope === 'page' ? 'summarize' : 'explain',
    tabId: target.id,
    pageUrl: target.url,
  })
})

/* ---------- right-click menus ---------- */

let menuWork = Promise.resolve()

function rebuildMenus(settings) {
  menuWork = menuWork.then(() => buildMenus(settings)).catch((err) => console.warn('ChroMind menus', err))
  return menuWork
}

async function buildMenus(settings) {
  await menus.removeAll()
  const add = (props) =>
    new Promise((resolve) => {
      menus.create(props, () => {
        void api.runtime.lastError
        resolve()
      })
    })
  const title = (action, scope) => {
    if (action.id === 'translate') return `Translate to ${settings.translateTo || 'English'}`
    if (scope === 'selection' && action.id === 'explain') return 'Explain “%s”'
    if (scope === 'page' && action.id === 'summarize') return 'Summarize this page'
    if (scope === 'link' && action.id === 'summarize') return 'Summarize linked page'
    return action.title
  }

  const selectionActions = actionsFor(settings, 'selection').filter((a) =>
    ['explain', 'summarize', 'translate', 'simplify', 'improve', 'factcheck', 'reply'].includes(a.id) || a.custom,
  )
  for (const action of selectionActions) {
    await add({ id: `selection|${action.id}`, title: title(action, 'selection'), contexts: ['selection'] })
  }
  await add({ id: 'selection|sep', type: 'separator', contexts: ['selection'] })
  await add({ id: 'selection|ask', title: 'Ask ChroMind about this…', contexts: ['selection'] })

  const pageActions = actionsFor(settings, 'page').filter(
    (a) => ['summarize', 'keypoints', 'questions', 'translate'].includes(a.id) || a.custom,
  )
  for (const action of pageActions) {
    await add({ id: `page|${action.id}`, title: title(action, 'page'), contexts: ['page'] })
  }
  await add({ id: 'page|sep', type: 'separator', contexts: ['page'] })
  await add({ id: 'page|ask', title: 'Ask about this page…', contexts: ['page'] })

  await add({ id: 'link|summarize', title: 'Summarize linked page', contexts: ['link'] })
  await add({ id: 'link|ask', title: 'Ask about linked page…', contexts: ['link'] })
  await add({ id: 'image|describe', title: 'Describe image', contexts: ['image'] })
  await add({ id: 'image|ask', title: 'Ask about this image…', contexts: ['image'] })
}

menus.onClicked.addListener((info, tab) => {
  const [scope, actionId] = String(info.menuItemId).split('|')
  // First thing, while the click still counts as a user gesture.
  openPanel({ tabId: tab?.id, windowId: tab?.windowId })
  const windowId = tab?.windowId ?? api.windows?.WINDOW_ID_CURRENT
  deliver(windowId, {
    scope,
    actionId,
    tabId: tab?.id,
    pageUrl: info.pageUrl ?? tab?.url,
    selection: info.selectionText ?? '',
    linkUrl: info.linkUrl ?? '',
    linkText: info.linkText ?? '',
    srcUrl: info.srcUrl ?? '',
  })
})

/* ---------- omnibox: "cm <question>" ---------- */

api.omnibox?.setDefaultSuggestion?.({ description: 'Ask ChroMind: %s' })
api.omnibox?.onInputEntered.addListener((text, disposition) => {
  const url = api.runtime.getURL(`sidepanel/sidepanel.html?mode=tab&q=${encodeURIComponent(text)}`)
  if (disposition === 'currentTab') api.tabs.update({ url })
  else api.tabs.create({ url, active: disposition !== 'newBackgroundTab' })
})

/* ---------- messages from content scripts and pages ---------- */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'open-thread') {
    const tab = sender.tab
    const opening = openPanel({ tabId: tab?.id, windowId: tab?.windowId })
    deliver(tab?.windowId, { scope: 'thread', threadId: msg.threadId })
    opening.then((opened) => sendResponse({ opened }))
    return true
  }
  if (msg?.type === 'open-options') {
    openOptions(msg.section || '')
    return false
  }
  return false
})

/* ---------- inline answers for the selection toolbar ---------- */

function handleInline(port) {
  const controller = new AbortController()
  port.onDisconnect.addListener(() => controller.abort())
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'stop') return controller.abort()
    if (msg.type !== 'run') return
    const settings = await getSettings()
    const action = findAction(settings, msg.actionId)
    const label = providerLabel(settings)
    const user = {
      id: crypto.randomUUID(),
      role: 'user',
      createdAt: Date.now(),
      text: msg.question?.trim() || (action ? actionPrompt(action, 'selection', settings) : 'Explain this.'),
      action: action ? { id: action.id, title: action.title } : null,
      contexts: [
        {
          kind: 'selection',
          title: msg.title || '',
          url: msg.url || '',
          text: msg.selection,
          chars: msg.selection.length,
          truncated: false,
        },
      ],
    }
    const thread = newThread({ title: threadTitle(user), messages: [user] })
    const assistant = {
      id: crypto.randomUUID(),
      role: 'assistant',
      createdAt: Date.now(),
      text: '',
      reasoning: '',
      provider: settings.provider,
      providerName: label.full,
    }
    port.postMessage({ type: 'start', provider: label.full })
    try {
      const result = await runChat({
        thread,
        settings,
        signal: controller.signal,
        emit: (evt) => {
          if (evt.type === 'text') assistant.text += evt.text
          if (evt.type === 'reasoning') assistant.reasoning += evt.text
          if (evt.type === 'meta' && evt.link) assistant.link = { url: evt.link, label: evt.linkLabel }
          try {
            port.postMessage(evt)
          } catch {
            controller.abort()
          }
        },
      })
      if (result?.providerState) thread.providerState[settings.provider] = result.providerState
      assistant.done = true
      thread.messages.push(assistant)
      if (settings.saveHistory) await saveThread(thread)
      port.postMessage({ type: 'done', threadId: settings.saveHistory ? thread.id : null })
    } catch (err) {
      try {
        port.postMessage({ type: 'error', error: serializeError(err) })
      } catch {
        // the card is gone
      }
    }
  })
}

/* ---------- lifecycle ---------- */

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await rebuildMenus(await getSettings())
  if (reason === 'install') openOptions('welcome')
})

api.runtime.onStartup?.addListener(async () => {
  await rebuildMenus(await getSettings())
})

let menuSignature = ''
onSettingsChanged((settings) => {
  // Only the translate label and custom actions show up in the menus.
  const signature = JSON.stringify([settings.translateTo, settings.customActions])
  if (signature === menuSignature) return
  menuSignature = signature
  rebuildMenus(settings)
})
