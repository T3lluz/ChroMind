/**
 * The side panel (Chromium) / sidebar (Firefox). Also opens as a full tab
 * (?mode=tab) from the omnibox keyword "cm".
 *
 * Chats run right here: this page streams from the provider, renders the
 * answer and saves the thread. The background only hands over requests
 * from menus and shortcuts (port "panel").
 */
import { api, openOptions, uid } from '../lib/browser.js'
import {
  canRead,
  captureVisible,
  imageToDataUrl,
  isYouTubeWatch,
  readLink,
  readSelection,
  readTab,
  seekVideo,
} from '../lib/extract.js'
import {
  clearThreads,
  deleteThread,
  listThreads,
  loadThread,
  newThread,
  saveThread,
  threadToMarkdown,
} from '../lib/history.js'
import { icon } from '../lib/icons.js'
import { actionPrompt, actionsFor, findAction, slashName, TARGETS, threadTitle } from '../lib/prompts.js'
import { deleteConversation } from '../lib/providers/claude-web.js'
import { serializeError } from '../lib/providers/errors.js'
import { getProvider, PROVIDERS, providerLabel, runChat } from '../lib/providers/index.js'
import { applyTheme, getSettings, onSettingsChanged, saveSettings } from '../lib/settings.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => globalThis.CMMarkdown.escape(s ?? '')
const PARAMS = new URLSearchParams(location.search)
const MODE = PARAMS.get('mode') === 'tab' ? 'tab' : 'panel'
/** ?window=<id>: follow another window's active tab (pop-out panel, tests). */
const FOLLOW_WINDOW = Number(PARAMS.get('window')) || null

const ACTION_BLURBS = {
  summarize: 'Overview and key points',
  keypoints: 'The essentials as bullets',
  explain: 'In plain language',
  eli5: 'With a simple analogy',
  translate: '',
  simplify: 'Easier to read',
  improve: 'Grammar and clarity',
  reply: 'A reply in the same tone',
  factcheck: 'Check the claims',
  questions: 'Questions worth asking',
  actions: 'Tasks, dates, decisions',
  compare: 'Side by side',
  describe: 'What the image shows',
}

const PROVIDER_ICONS = { 'claude-web': 'spark', 'claude-code': 'bridge', cursor: 'bridge', hermes: 'server', custom: 'server' }

const state = {
  settings: null,
  windowId: null,
  tab: null,
  pageOn: true,
  extraTabs: new Map(),
  attachments: [],
  thread: newThread(),
  controller: null,
  slashIndex: 0,
  speaking: null,
}

/* ---------- small helpers ---------- */

function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstElementChild) continue
    el.innerHTML = icon(el.dataset.icon, 18)
  }
}

let toastTimer = 0
function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 2600)
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const FALLBACK_FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3ee6b0" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  )

function faviconFor(tab) {
  const url = tab?.favIconUrl || ''
  if (/^(https?:|data:)/.test(url)) return url
  return canRead(tab?.url) ? FALLBACK_FAVICON : ''
}

function nearBottom() {
  const s = $('scroller')
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120
}

function scrollToBottom(force = false) {
  const s = $('scroller')
  if (force || nearBottom()) s.scrollTop = s.scrollHeight
}

function isVideo(tab = state.tab) {
  return isYouTubeWatch(tab?.url)
}

function hasVideoContext(thread = state.thread) {
  return thread.messages.some((m) => m.contexts?.some((c) => c.kind === 'youtube'))
}

function currentScope() {
  if (state.attachments.some((a) => a.kind === 'selection')) return 'selection'
  if (state.attachments.some((a) => a.kind === 'link')) return 'link'
  if (state.attachments.some((a) => a.kind === 'image')) return 'image'
  if (state.extraTabs.size) return 'tabs'
  return isVideo() ? 'youtube' : 'page'
}

/* ---------- provider pill and menu ---------- */

function renderProvider() {
  const label = providerLabel(state.settings)
  $('providerName').textContent = label.name
  $('providerModel').textContent = label.model
  $('providerBtn').title = `Answering with ${label.full}`
  const provider = getProvider(state.settings.provider)
  $('shotBtn').disabled = !provider.images || MODE === 'tab'
  $('shotBtn').title = provider.images
    ? 'Attach a screenshot of the page'
    : `${provider.name} can't see images`
}

function renderProviderMenu() {
  const menu = $('providerMenu')
  const s = state.settings
  menu.innerHTML =
    '<div class="menu-label">Answer with</div>' +
    PROVIDERS.map((p) => {
      const active = p.id === s.provider
      const cfg = s.providers[p.id] ?? {}
      const name = p.id === 'custom' && cfg.name ? cfg.name : p.name
      const models =
        active && p.models.length
          ? `<div class="menu-models">${p.models
              .map(
                (m) =>
                  `<button type="button" class="model-chip" data-model="${esc(m.id)}" aria-pressed="${(cfg.model || '') === m.id}">${esc(m.label)}</button>`,
              )
              .join('')}${
              p.freeModel && cfg.model && !p.models.some((m) => m.id === cfg.model)
                ? `<button type="button" class="model-chip" aria-pressed="true">${esc(cfg.model)}</button>`
                : ''
            }</div>`
          : ''
      return `<button type="button" class="menu-item" role="menuitemradio" aria-checked="${active}" data-provider="${p.id}">
          <span data-icon="${PROVIDER_ICONS[p.id] ?? 'spark'}"></span>
          <span class="menu-copy"><strong>${esc(name)}</strong><small>${esc(p.detail)}</small></span>
          <span class="menu-check" data-icon="check"></span>
        </button>${models}`
    }).join('') +
    '<div class="menu-sep"></div><button type="button" class="menu-item" data-open-settings="providers"><span data-icon="settings"></span><span class="menu-copy"><strong>Provider settings</strong><small>Bridge, Hermes server, models</small></span></button>'
  hydrateIcons(menu)
}

function toggleMenu(menu, button, open = menu.hidden) {
  closeMenus()
  if (!open) return
  menu.hidden = false
  button?.setAttribute('aria-expanded', 'true')
  const rect = button.getBoundingClientRect()
  const shell = $('shell').getBoundingClientRect()
  menu.style.top = `${rect.bottom - shell.top + 6}px`
  menu.style.left = `${Math.max(12, Math.min(rect.left - shell.left, shell.width - menu.offsetWidth - 12))}px`
}

function closeMenus() {
  for (const id of ['providerMenu', 'tabsMenu']) $(id).hidden = true
  for (const id of ['providerBtn', 'tabsBtn']) $(id).setAttribute('aria-expanded', 'false')
}

/* ---------- page context ---------- */

async function refreshTab() {
  if (MODE === 'tab') return renderContext()
  const [tab] = await api.tabs.query({ active: true, windowId: state.windowId })
  state.tab = tab ?? null
  renderContext()
}

function renderContext() {
  const tab = MODE === 'tab' ? null : state.tab
  const readable = canRead(tab?.url)
  const video = isVideo(tab)
  $('ctxFavicon').src = faviconFor(tab)
  $('ctxTitle').textContent = MODE === 'tab' ? 'Full-page chat' : tab?.title || 'No page'
  $('ctxMeta').innerHTML =
    MODE === 'tab'
      ? 'No page attached. Open the side panel to chat about a page.'
      : !tab
        ? ''
        : readable
          ? `${esc(hostOf(tab.url))}${video ? ' · <span class="badge">Video transcript</span>' : ''}`
          : "ChroMind can't read this page"
  const toggle = $('ctxToggle')
  toggle.disabled = !readable
  toggle.setAttribute('aria-pressed', String(readable && state.pageOn))
  $('ctxToggleLabel').textContent = video ? 'Video' : 'Page'
  $('tabsBtn').hidden = MODE === 'tab'
  const on = readable && state.pageOn
  $('input').placeholder = on ? (video ? 'Ask about this video…' : 'Ask about this page…') : 'Ask anything…'
  $('welcomeSub').textContent = on
    ? `Ask anything about this ${video ? 'video' : 'page'}, or start with an action.`
    : 'Ask anything, or open a page to chat about it.'
  renderChips()
  renderActionGrid()
  renderStatus()
}

function renderChips() {
  const box = $('ctxChips')
  box.hidden = state.extraTabs.size === 0
  box.innerHTML = [...state.extraTabs.values()]
    .map(
      (t) => `<span class="chip" title="${esc(t.url)}">${faviconFor(t) ? `<img src="${esc(faviconFor(t))}" alt="">` : '<span data-icon="page"></span>'}
        <span class="label">${esc(t.title || hostOf(t.url))}</span>
        <button type="button" data-remove-tab="${t.id}" title="Remove">${icon('close', 12)}</button></span>`,
    )
    .join('')
  hydrateIcons(box)
}

async function renderTabsMenu() {
  const menu = $('tabsMenu')
  const tabs = (await api.tabs.query({ windowId: state.windowId })).filter(
    (t) => t.id !== state.tab?.id && canRead(t.url),
  )
  menu.innerHTML =
    '<div class="menu-label">Add tabs to the chat</div>' +
    (tabs.length
      ? tabs
          .map(
            (t) => `<button type="button" class="menu-item" role="menuitemcheckbox" aria-checked="${state.extraTabs.has(t.id)}" data-tab="${t.id}">
          ${faviconFor(t) ? `<img src="${esc(faviconFor(t))}" alt="" width="16" height="16" style="border-radius:4px">` : '<span data-icon="page"></span>'}
          <span class="menu-copy"><strong>${esc(t.title || t.url)}</strong><small>${esc(hostOf(t.url))}</small></span>
          <span class="menu-check" data-icon="check"></span></button>`,
          )
          .join('')
      : '<div class="menu-empty">No other readable tabs in this window.</div>')
  hydrateIcons(menu)
  return tabs
}

function renderStatus() {
  const parts = []
  if (MODE !== 'tab' && canRead(state.tab?.url) && state.pageOn) parts.push(isVideo() ? 'Video' : 'This page')
  if (state.extraTabs.size) parts.push(`${state.extraTabs.size} tab${state.extraTabs.size > 1 ? 's' : ''}`)
  const att = state.attachments
  if (att.length) parts.push(att.map((a) => a.kind).join(', '))
  $('composerStatus').textContent = state.controller
    ? 'Answering…'
    : parts.length
      ? `Sends: ${parts.join(' + ')}`
      : 'No page context'
}

/* ---------- attachments in the composer ---------- */

function addAttachment(att) {
  if (att.kind === 'selection') state.attachments = state.attachments.filter((a) => a.kind !== 'selection')
  state.attachments.push({ id: uid(), ...att })
  renderAttachments()
}

function renderAttachments() {
  const box = $('attachments')
  box.hidden = state.attachments.length === 0
  box.innerHTML = state.attachments
    .map((a) => {
      const lead =
        a.kind === 'image'
          ? `<img class="chip-thumb" src="${esc(a.dataUrl)}" alt="">`
          : `<span data-icon="${a.kind === 'selection' ? 'quote' : 'link'}"></span>`
      const label =
        a.kind === 'selection' ? `“${a.text.replace(/\s+/g, ' ').slice(0, 60)}${a.text.length > 60 ? '…' : ''}”` : a.title || a.url
      return `<span class="chip">${lead}<span class="label">${esc(label)}</span><button type="button" data-remove-att="${a.id}" title="Remove">${icon('close', 12)}</button></span>`
    })
    .join('')
  hydrateIcons(box)
  renderActionGrid()
  renderStatus()
  updateSendButton()
}

/* ---------- welcome actions ---------- */

function renderActionGrid() {
  if (!state.settings) return
  const scope = currentScope()
  const preferred = {
    page: ['summarize', 'keypoints', 'explain', 'questions', 'translate', 'actions'],
    youtube: ['summarize', 'keypoints', 'questions'],
    selection: ['explain', 'summarize', 'translate', 'simplify', 'improve', 'factcheck'],
    tabs: ['compare', 'summarize', 'keypoints', 'questions'],
    link: ['summarize', 'keypoints', 'questions'],
    image: ['describe', 'explain'],
  }[scope]
  const actions = actionsFor(state.settings, scope)
  const ordered = [
    ...preferred.map((id) => actions.find((a) => a.id === id)).filter(Boolean),
    ...actions.filter((a) => a.custom),
  ].slice(0, 8)
  const pageless = (scope === 'page' || scope === 'youtube') && !canRead(state.tab?.url)
  $('actionGrid').innerHTML = pageless
    ? ''
    : ordered
        .map((a) => {
          const blurb = a.custom ? 'Your action' : a.id === 'translate' ? `Into ${state.settings.translateTo}` : ACTION_BLURBS[a.id]
          return `<button type="button" class="action-card" data-action="${esc(a.id)}"><span data-icon="${esc(a.icon)}"></span><strong>${esc(a.title)}</strong><small>${esc(blurb ?? '')}</small></button>`
        })
        .join('')
  hydrateIcons($('actionGrid'))
}

/* ---------- messages ---------- */

const CONTEXT_ICONS = { page: 'page', youtube: 'video', link: 'link', selection: 'quote', tab: 'tabs' }

function userHTML(m) {
  const contexts = (m.contexts ?? [])
    .map(
      (c) =>
        `<span class="chip" title="${esc(c.url || '')}"><span data-icon="${CONTEXT_ICONS[c.kind] ?? 'page'}"></span><span class="label">${esc(
          c.kind === 'selection' ? `“${c.text.replace(/\s+/g, ' ').slice(0, 48)}…”` : c.title || hostOf(c.url),
        )}</span></span>`,
    )
    .join('')
  const images = (m.images ?? []).map((img) => `<img src="${esc(img.dataUrl)}" alt="">`).join('')
  const tag = m.action
    ? `<span class="action-tag"><span data-icon="${esc(m.action.icon || 'zap')}"></span>${esc(m.action.title)}</span>`
    : ''
  const text = m.action ? m.display ?? '' : m.text
  return `${contexts ? `<div class="msg-contexts">${contexts}</div>` : ''}${images ? `<div class="msg-images">${images}</div>` : ''}<div class="bubble">${tag}${esc(text)}</div>`
}

function messageView(m) {
  const el = document.createElement('div')
  el.dataset.id = m.id
  if (m.role === 'user') {
    el.className = 'msg-user'
    el.innerHTML = userHTML(m)
  } else {
    el.className = 'msg-assistant'
    el.innerHTML = `<div class="msg-head"><img class="msg-avatar" src="../icons/icon.svg" alt=""><strong>ChroMind</strong><span class="msg-provider"></span></div>
      <details class="thinking" hidden><summary><span data-icon="brain"></span><span class="label"></span></summary><div class="thinking-body"></div></details>
      <div class="tool-list" hidden></div>
      <div class="waiting" hidden><i></i><i></i><i></i></div>
      <div class="md"></div>
      <div class="msg-error" hidden></div>
      <div class="msg-actions" hidden></div>`
    updateAssistant(el, m)
  }
  hydrateIcons(el)
  return el
}

function updateAssistant(el, m) {
  el.classList.toggle('streaming', !!m.streaming)
  el.querySelector('.msg-provider').textContent = `· ${m.providerName ?? ''}`

  const thinking = el.querySelector('.thinking')
  thinking.hidden = !m.reasoning
  if (m.reasoning) {
    thinking.querySelector('.label').textContent =
      m.streaming && !m.text ? 'Thinking…' : m.thoughtFor ? `Thought for ${m.thoughtFor}s` : 'Thoughts'
    thinking.querySelector('.thinking-body').textContent = m.reasoning
  }

  const tools = el.querySelector('.tool-list')
  tools.hidden = !m.tools?.length
  if (m.tools?.length) {
    tools.innerHTML = m.tools
      .map((t) => `<span class="tool-chip" title="${esc(t.detail || '')}">${icon('tool', 11)}${esc(t.name)}${t.count > 1 ? ` ×${t.count}` : ''}</span>`)
      .join('')
  }

  el.querySelector('.waiting').hidden = !(m.streaming && !m.text)
  el.querySelector('.md').innerHTML = globalThis.CMMarkdown.render(m.text, { timestamps: hasVideoContext() })

  const error = el.querySelector('.msg-error')
  const showError = m.error && m.error.code !== 'aborted'
  error.hidden = !showError
  if (showError) {
    const fix = m.error.link
      ? `<a class="btn" href="${esc(m.error.link)}" target="_blank" rel="noopener">${esc(m.error.linkLabel || 'Open')}</a>`
      : m.error.action
        ? `<button type="button" class="btn" data-act="settings" data-section="${m.error.action === 'settings:bridge' ? 'bridge' : 'providers'}">Open settings</button>`
        : ''
    error.innerHTML = `<p>${icon('alert', 16)}<span>${esc(m.error.message)}</span></p><div style="display:flex;gap:6px;flex-wrap:wrap">${fix}<button type="button" class="btn" data-act="retry">Try again</button></div>`
  }

  const actions = el.querySelector('.msg-actions')
  actions.hidden = m.streaming || (!m.text && !m.error)
  if (!actions.hidden) {
    actions.innerHTML =
      (m.text
        ? `<button type="button" class="icon-btn ghost" data-act="copy" title="Copy">${icon('copy', 14)}</button>
           <button type="button" class="icon-btn ghost" data-act="speak" title="Read aloud">${icon('speaker', 14)}</button>`
        : '') +
      `<button type="button" class="icon-btn ghost" data-act="regen" title="Regenerate">${icon('refresh', 14)}</button>` +
      (m.link ? `<a class="link-btn" href="${esc(m.link.url)}" target="_blank" rel="noopener">${icon('external', 13)}${esc(m.link.label)}</a>` : '') +
      (m.stopped ? '<span class="composer-status">Stopped</span>' : '')
  }
}

function renderThread() {
  const box = $('messages')
  box.textContent = ''
  for (const m of state.thread.messages) box.append(messageView(m))
  $('welcome').hidden = state.thread.messages.length > 0
  scrollToBottom(true)
}

function viewFor(id) {
  return $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`)
}

/* ---------- sending ---------- */

function knownUrls() {
  return new Set(state.thread.messages.flatMap((m) => (m.contexts ?? []).filter((c) => c.kind !== 'selection').map((c) => c.url)))
}

async function gatherContexts({ includePage }) {
  const max = Number(state.settings.maxPageChars) || 60000
  const known = knownUrls()
  const contexts = []
  const warn = (err) => toast(err?.message || String(err))
  if (includePage && MODE !== 'tab' && canRead(state.tab?.url) && !known.has(state.tab.url)) {
    const ctx = await readTab(state.tab, { maxChars: max }).catch(warn)
    if (ctx?.text) contexts.push({ ...ctx, tabId: state.tab.id })
  }
  const share = Math.max(8000, Math.floor(max / (state.extraTabs.size + 1)))
  for (const tab of state.extraTabs.values()) {
    if (known.has(tab.url)) continue
    const ctx = await readTab(tab, { maxChars: share }).catch(warn)
    if (ctx?.text) contexts.push({ ...ctx, kind: ctx.kind === 'youtube' ? 'youtube' : 'tab', tabId: tab.id })
  }
  for (const att of state.attachments) {
    if (att.kind === 'selection') {
      contexts.push({ kind: 'selection', title: att.title, url: att.url, text: att.text, chars: att.text.length, truncated: false })
    } else if (att.kind === 'link' && !known.has(att.url)) {
      const ctx = await readLink(att.url, { maxChars: max }).catch(warn)
      if (ctx?.text) contexts.push(ctx)
    }
  }
  return contexts
}

async function submit({ text, display, action = null, includePage = state.pageOn } = {}) {
  if (state.controller) return
  const message = {
    id: uid(),
    role: 'user',
    createdAt: Date.now(),
    text,
    display,
    action: action ? { id: action.id, title: action.title, icon: action.icon } : null,
    contexts: [],
    images: [],
  }
  $('composerStatus').textContent = 'Reading…'
  message.contexts = await gatherContexts({ includePage })
  message.images = state.attachments.filter((a) => a.kind === 'image').map((a) => ({ dataUrl: a.dataUrl, name: a.name }))
  state.attachments = []
  renderAttachments()
  if (!state.thread.messages.length) state.thread.title = threadTitle(message)
  state.thread.messages.push(message)
  $('welcome').hidden = true
  $('messages').append(messageView(message))
  scrollToBottom(true)
  await respond()
}

async function respond() {
  const settings = state.settings
  const thread = state.thread
  const label = providerLabel(settings)
  const assistant = {
    id: uid(),
    role: 'assistant',
    createdAt: Date.now(),
    text: '',
    reasoning: '',
    tools: [],
    provider: settings.provider,
    providerName: label.full,
    streaming: true,
  }
  const controller = new AbortController()
  state.controller = controller
  setStreaming(true)
  const history = thread.messages.slice()
  thread.messages.push(assistant)
  const view = messageView(assistant)
  $('messages').append(view)
  scrollToBottom(true)

  let frame = 0
  let reasoningStart = 0
  const paint = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const stick = nearBottom()
      updateAssistant(view, assistant)
      if (stick) scrollToBottom(true)
    })
  }
  try {
    const result = await runChat({
      thread: { ...thread, messages: history },
      settings,
      signal: controller.signal,
      emit: (evt) => {
        if (evt.type === 'text') {
          if (reasoningStart && !assistant.thoughtFor) {
            assistant.thoughtFor = Math.max(1, Math.round((Date.now() - reasoningStart) / 1000))
          }
          assistant.text += evt.text
        } else if (evt.type === 'reasoning') {
          reasoningStart ||= Date.now()
          assistant.reasoning += evt.text
        } else if (evt.type === 'tool') {
          const last = assistant.tools.at(-1)
          if (last?.name === evt.name) last.count = (last.count ?? 1) + 1
          else assistant.tools.push({ name: evt.name, detail: evt.detail || '' })
        } else if (evt.type === 'meta') {
          if (evt.link) assistant.link = { url: evt.link, label: evt.linkLabel || 'Open' }
        }
        paint()
      },
    })
    if (result?.providerState) thread.providerState = { ...thread.providerState, [settings.provider]: result.providerState }
    if (!assistant.text.trim()) assistant.error = { message: `${label.name} sent an empty answer.`, code: 'empty' }
  } catch (err) {
    if (err?.name === 'AbortError') {
      assistant.stopped = true
      if (!assistant.text) assistant.error = { message: 'Stopped.', code: 'aborted' }
    } else {
      assistant.error = serializeError(err)
    }
  } finally {
    cancelAnimationFrame(frame)
    if (reasoningStart && !assistant.thoughtFor) {
      assistant.thoughtFor = Math.max(1, Math.round((Date.now() - reasoningStart) / 1000))
    }
    assistant.streaming = false
    state.controller = null
    setStreaming(false)
    updateAssistant(view, assistant)
    persist()
  }
}

function setStreaming(on) {
  const btn = $('sendBtn')
  btn.classList.toggle('is-stop', on)
  btn.innerHTML = icon(on ? 'stop' : 'send', on ? 13 : 17)
  btn.title = on ? 'Stop (Esc)' : 'Send'
  updateSendButton()
  renderStatus()
}

function updateSendButton() {
  $('sendBtn').disabled = !state.controller && !$('input').value.trim() && !state.attachments.length
}

async function persist() {
  const thread = state.thread
  if (state.settings.saveHistory && thread.messages.length) {
    const clean = { ...thread, messages: thread.messages.map(({ streaming, ...m }) => m) }
    await saveThread(clean).catch(() => {})
  }
  await api.storage.session?.set({ [`panel:${state.windowId}`]: thread.id }).catch(() => {})
}

async function runAction(action, { scope = currentScope(), extra = '' } = {}) {
  if ((scope === 'page' || scope === 'youtube') && !canRead(state.tab?.url)) {
    toast("ChroMind can't read this page.")
    return
  }
  let text = actionPrompt(action, scope, state.settings)
  if (extra) text += `\n\n${extra}`
  const pageScopes = ['page', 'youtube', 'tabs']
  await submit({ text, display: extra || `on ${TARGETS[scope] ?? 'this'}`, action, includePage: pageScopes.includes(scope) })
}

async function sendFromComposer() {
  const input = $('input')
  const raw = input.value.trim()
  if (!raw && !state.attachments.length) return
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  if (slash) {
    const action = actionsFor(state.settings, currentScope()).find((a) => slashName(a) === `/${slash[1].toLowerCase()}`)
    if (action) {
      input.value = ''
      autosize()
      hideSlash()
      return runAction(action, { extra: slash[2]?.trim() ?? '' })
    }
  }
  input.value = ''
  autosize()
  hideSlash()
  await submit({ text: raw || 'What is this?' })
}

/* ---------- slash menu ---------- */

function slashMatches() {
  const m = /^\/(\S*)$/.exec($('input').value)
  if (!m) return null
  const q = m[1].toLowerCase()
  return actionsFor(state.settings, currentScope()).filter((a) => slashName(a).slice(1).startsWith(q) || a.title.toLowerCase().includes(q))
}

function showSlash(actions = slashMatches()) {
  const menu = $('slashMenu')
  if (!actions?.length) return hideSlash()
  state.slashIndex = Math.min(state.slashIndex, actions.length - 1)
  menu.innerHTML =
    `<div class="menu-label">Actions on ${esc(TARGETS[currentScope()])}</div>` +
    actions
      .map(
        (a, i) => `<button type="button" class="menu-item${i === state.slashIndex ? ' is-active' : ''}" role="option" data-slash="${esc(a.id)}">
        <span data-icon="${esc(a.icon)}"></span><span class="menu-copy"><strong>${esc(a.title)}</strong></span><span class="menu-hint">${esc(slashName(a))}</span></button>`,
      )
      .join('')
  menu.hidden = false
  menu._actions = actions
  hydrateIcons(menu)
}

function hideSlash() {
  $('slashMenu').hidden = true
  state.slashIndex = 0
}

/* ---------- threads ---------- */

async function startNewThread() {
  if (state.controller) state.controller.abort()
  await maybeForgetClaudeChat(state.thread)
  state.thread = newThread()
  state.attachments = []
  renderAttachments()
  renderThread()
  persist()
}

async function maybeForgetClaudeChat(thread) {
  if (state.settings.providers['claude-web']?.keepHistory === false && thread.providerState?.['claude-web']) {
    await deleteConversation(thread.providerState['claude-web'])
  }
}

function openThread(thread) {
  if (state.controller) state.controller.abort()
  state.thread = thread
  renderThread()
  persist()
}

function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 864e5)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  if (Date.now() - ts < 7 * 864e5) return 'This week'
  return 'Earlier'
}

async function renderHistory() {
  const q = $('historySearch').value.trim().toLowerCase()
  const threads = (await listThreads()).filter(
    (t) => !q || t.title.toLowerCase().includes(q) || (t.preview ?? '').toLowerCase().includes(q),
  )
  let group = ''
  let html = ''
  for (const t of threads) {
    const label = dayLabel(t.updatedAt)
    if (label !== group) {
      group = label
      html += `<div class="history-group">${label}</div>`
    }
    html += `<button type="button" class="history-item${t.id === state.thread.id ? ' is-current' : ''}" data-thread="${t.id}">
      <strong>${esc(t.title)}</strong><small>${esc(t.preview || hostOf(t.url))}</small>
      <span class="icon-btn sm ghost" role="button" data-delete-thread="${t.id}" title="Delete">${icon('trash', 14)}</span></button>`
  }
  $('historyList').innerHTML =
    html ||
    `<div class="menu-empty">${q ? 'No chats match.' : state.settings.saveHistory ? 'No saved chats yet.' : 'History is off in settings.'}</div>`
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/* ---------- requests from menus and shortcuts ---------- */

async function handleRequest(req) {
  if (!req) return
  if (req.scope === 'thread') {
    const thread = req.threadId && (await loadThread(req.threadId))
    if (thread) openThread(thread)
    return
  }
  let tab = state.tab
  if (typeof req.tabId === 'number') tab = (await api.tabs.get(req.tabId).catch(() => null)) ?? tab
  if (tab?.active && tab.windowId === state.windowId) {
    state.tab = tab
    renderContext()
  }
  const action = req.actionId && req.actionId !== 'ask' ? findAction(state.settings, req.actionId) : null
  if (action && (state.thread.messages.length || state.controller)) await startNewThread()

  try {
    if (req.scope === 'selection') {
      let text = req.selection || ''
      const full = await readSelection(tab)
      if (full.length >= text.length) text = full
      if (!text) return toast('Select some text first.')
      addAttachment({ kind: 'selection', title: tab?.title ?? '', url: tab?.url ?? req.pageUrl, text })
      if (action) await runAction(action, { scope: 'selection' })
      else focusInput('Ask about the selection…')
    } else if (req.scope === 'page') {
      if (action) await runAction(action, { scope: isVideo(tab) ? 'youtube' : 'page' })
      else {
        state.pageOn = true
        renderContext()
        focusInput()
      }
    } else if (req.scope === 'link') {
      addAttachment({ kind: 'link', title: req.linkText || hostOf(req.linkUrl) || req.linkUrl, url: req.linkUrl })
      if (action) await runAction(action, { scope: 'link' })
      else focusInput('Ask about the linked page…')
    } else if (req.scope === 'image') {
      const dataUrl = await imageToDataUrl(req.srcUrl)
      addAttachment({ kind: 'image', name: 'image.jpg', title: 'Image', dataUrl })
      if (action) await runAction(action, { scope: 'image' })
      else focusInput('Ask about the image…')
    }
  } catch (err) {
    toast(err?.message || String(err))
  }
}

function focusInput(placeholder) {
  const input = $('input')
  if (placeholder) input.placeholder = placeholder
  input.focus()
}

/* ---------- composer sizing ---------- */

function autosize() {
  const input = $('input')
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`
}

/* ---------- events ---------- */

function bindEvents() {
  const input = $('input')
  input.addEventListener('input', () => {
    autosize()
    updateSendButton()
    if (input.value.startsWith('/')) showSlash()
    else hideSlash()
  })
  input.addEventListener('keydown', (e) => {
    const menu = $('slashMenu')
    if (!menu.hidden && menu._actions) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = menu._actions.length
        state.slashIndex = (state.slashIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
        return showSlash(menu._actions)
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        const action = menu._actions[state.slashIndex]
        input.value = ''
        autosize()
        hideSlash()
        return runAction(action)
      }
      if (e.key === 'Escape') return hideSlash()
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (state.settings.sendOnEnter || e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (!state.controller) sendFromComposer()
    }
  })

  $('sendBtn').addEventListener('click', () => (state.controller ? state.controller.abort() : sendFromComposer()))

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.controller) state.controller.abort()
      closeMenus()
      hideSlash()
      $('historyDrawer').hidden = true
    }
  })

  document.addEventListener('click', (e) => {
    const t = e.target
    if (!t.closest('#providerMenu, #providerBtn, #tabsMenu, #tabsBtn')) closeMenus()
    if (!t.closest('#slashMenu, #actionsBtn, #input')) hideSlash()
  })

  $('slashMenu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-slash]')
    if (!item) return
    const action = findAction(state.settings, item.dataset.slash)
    $('input').value = ''
    autosize()
    hideSlash()
    if (action) runAction(action)
  })

  $('actionsBtn').addEventListener('click', () => {
    if (!$('slashMenu').hidden) return hideSlash()
    showSlash(actionsFor(state.settings, currentScope()))
  })

  $('providerBtn').addEventListener('click', () => {
    renderProviderMenu()
    toggleMenu($('providerMenu'), $('providerBtn'))
  })

  $('providerMenu').addEventListener('click', async (e) => {
    const provider = e.target.closest('[data-provider]')
    const model = e.target.closest('[data-model]')
    const settings = e.target.closest('[data-open-settings]')
    if (provider) {
      state.settings = await saveSettings({ provider: provider.dataset.provider })
    } else if (model) {
      state.settings = await saveSettings({ providers: { [state.settings.provider]: { model: model.dataset.model } } })
    } else if (settings) {
      closeMenus()
      return openOptions(settings.dataset.openSettings)
    } else return
    renderProvider()
    renderProviderMenu()
  })

  $('tabsBtn').addEventListener('click', async () => {
    await renderTabsMenu()
    toggleMenu($('tabsMenu'), $('tabsBtn'))
  })

  $('tabsMenu').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-tab]')
    if (!item) return
    const id = Number(item.dataset.tab)
    if (state.extraTabs.has(id)) state.extraTabs.delete(id)
    else state.extraTabs.set(id, await api.tabs.get(id))
    item.setAttribute('aria-checked', String(state.extraTabs.has(id)))
    renderChips()
    renderActionGrid()
    renderStatus()
  })

  $('ctxChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-tab]')
    if (!btn) return
    state.extraTabs.delete(Number(btn.dataset.removeTab))
    renderChips()
    renderActionGrid()
    renderStatus()
  })

  $('attachments').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-att]')
    if (!btn) return
    state.attachments = state.attachments.filter((a) => a.id !== btn.dataset.removeAtt)
    renderAttachments()
  })

  $('ctxToggle').addEventListener('click', () => {
    state.pageOn = !state.pageOn
    renderContext()
  })

  $('actionGrid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-action]')
    const action = card && findAction(state.settings, card.dataset.action)
    if (action) runAction(action)
  })

  $('shotBtn').addEventListener('click', async () => {
    try {
      const dataUrl = await captureVisible(state.windowId)
      addAttachment({ kind: 'image', name: 'screenshot.jpg', title: 'Screenshot', dataUrl })
      $('input').focus()
    } catch (err) {
      toast(`Screenshot failed: ${err?.message || err}`)
    }
  })

  $('newChatBtn').addEventListener('click', () => startNewThread())
  $('settingsBtn').addEventListener('click', () => openOptions())
  $('historyBtn').addEventListener('click', async () => {
    await renderHistory()
    $('historyDrawer').hidden = false
    $('historySearch').focus()
  })
  $('historyClose').addEventListener('click', () => ($('historyDrawer').hidden = true))
  $('historySearch').addEventListener('input', renderHistory)
  $('historyList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delete-thread]')
    if (del) {
      e.stopPropagation()
      const thread = await loadThread(del.dataset.deleteThread)
      if (thread) await maybeForgetClaudeChat(thread)
      await deleteThread(del.dataset.deleteThread)
      if (del.dataset.deleteThread === state.thread.id) await startNewThread()
      return renderHistory()
    }
    const item = e.target.closest('[data-thread]')
    if (!item) return
    const thread = await loadThread(item.dataset.thread)
    if (thread) openThread(thread)
    $('historyDrawer').hidden = true
  })
  $('exportBtn').addEventListener('click', () => {
    if (!state.thread.messages.length) return toast('Nothing to export yet.')
    const name = state.thread.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat'
    download(`ChroMind - ${name}.md`, threadToMarkdown(state.thread))
  })
  $('clearHistoryBtn').addEventListener('click', async () => {
    if (!confirm('Delete all saved ChroMind chats on this device?')) return
    await clearThreads()
    renderHistory()
    toast('History cleared')
  })

  $('messages').addEventListener('click', async (e) => {
    const copyCode = e.target.closest('.cm-copy-code')
    if (copyCode) {
      const code = copyCode.closest('.cm-code').querySelector('code').textContent
      await navigator.clipboard.writeText(code)
      copyCode.textContent = 'Copied'
      setTimeout(() => (copyCode.textContent = 'Copy'), 1400)
      return
    }
    const ts = e.target.closest('.cm-ts')
    if (ts) return seekTo(Number(ts.dataset.seconds))
    const btn = e.target.closest('[data-act]')
    if (!btn) return
    const id = btn.closest('[data-id]')?.dataset.id
    const index = state.thread.messages.findIndex((m) => m.id === id)
    const m = state.thread.messages[index]
    switch (btn.dataset.act) {
      case 'copy':
        await navigator.clipboard.writeText(m.text)
        toast('Copied')
        break
      case 'speak':
        speak(m.text)
        break
      case 'settings':
        openOptions(btn.dataset.section || '')
        break
      case 'regen':
      case 'retry':
        if (state.controller || index < 0) return
        state.thread.messages.splice(index, 1)
        viewFor(id)?.remove()
        respond()
        break
    }
  })

  api.tabs.onActivated.addListener(({ windowId }) => {
    if (windowId === state.windowId) refreshTab()
  })
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.windowId !== state.windowId) return
    if (state.extraTabs.has(tabId)) state.extraTabs.set(tabId, tab)
    if (tab.active && (change.title || change.url || change.favIconUrl || change.status === 'complete')) {
      state.tab = tab
      renderContext()
    }
  })
  api.tabs.onRemoved.addListener((tabId) => {
    if (state.extraTabs.delete(tabId)) renderChips()
  })

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings.theme))
}

async function seekTo(seconds) {
  const ctx = state.thread.messages.flatMap((m) => m.contexts ?? []).find((c) => c.kind === 'youtube')
  let tabId = ctx?.tabId
  if (state.tab && ctx && state.tab.url?.split('&')[0] === ctx.url?.split('&')[0]) tabId = state.tab.id
  if (typeof tabId !== 'number') return toast('Open the video tab to jump to that moment.')
  await seekVideo(tabId, seconds).catch(() => toast('Could not reach the video tab.'))
}

function speak(text) {
  const synth = globalThis.speechSynthesis
  if (!synth) return toast('Read aloud is not available here.')
  if (synth.speaking) {
    synth.cancel()
    if (state.speaking === text) return (state.speaking = null)
  }
  const plain = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[#*_`>|[\]()-]/g, ' ')
  const utterance = new SpeechSynthesisUtterance(plain)
  utterance.onend = () => (state.speaking = null)
  state.speaking = text
  synth.speak(utterance)
}

/* ---------- start ---------- */

async function init() {
  state.settings = await getSettings()
  applyTheme(state.settings.theme)
  state.pageOn = state.settings.pageContext
  document.body.classList.toggle('mode-tab', MODE === 'tab')
  hydrateIcons()
  bindEvents()
  renderProvider()

  state.windowId = FOLLOW_WINDOW ?? (await api.windows.getCurrent()).id
  await refreshTab()

  const key = `panel:${state.windowId}`
  const restored = MODE === 'panel' ? (await api.storage.session?.get(key).catch(() => ({})))?.[key] : null
  const thread = restored && (await loadThread(restored))
  if (thread) state.thread = thread
  renderThread()

  onSettingsChanged((settings) => {
    state.settings = settings
    applyTheme(settings.theme)
    renderProvider()
    renderActionGrid()
  })

  if (MODE === 'panel') {
    const port = api.runtime.connect({ name: 'panel' })
    port.onMessage.addListener((msg) => {
      if (msg.type === 'request') handleRequest(msg.request)
    })
    port.postMessage({ type: 'hello', windowId: state.windowId })
  } else {
    const q = PARAMS.get('q')
    if (q) submit({ text: q, includePage: false })
  }
  $('input').focus()
}

init()
