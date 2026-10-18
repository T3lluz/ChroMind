import { logo } from '../lib/brands.js'
import { api, isFirefox, version } from '../lib/browser.js'
import { clearThreads } from '../lib/history.js'
import { icon } from '../lib/icons.js'
import {
  ACCESS,
  bridgeApps,
  detectServer,
  getProvider,
  isReady,
  providerModels,
  PROVIDERS,
  testProvider,
} from '../lib/providers/index.js'
import { applyTheme, DEFAULTS, getSettings, saveSettings } from '../lib/settings.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => globalThis.CMMarkdown.escape(s ?? '')

const LANGUAGES = [
  'English', 'Norwegian', 'Swedish', 'Danish', 'Finnish', 'German', 'French', 'Spanish', 'Portuguese', 'Italian',
  'Dutch', 'Polish', 'Ukrainian', 'Turkish', 'Arabic', 'Hindi', 'Japanese', 'Korean', 'Chinese (Simplified)',
  'Chinese (Traditional)',
]

let settings = null

function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon, 16)
  }
}

let toastTimer = 0
function toast(text) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 1800)
}

/* ---------- saving ---------- */

/**
 * Debounced save. Patches pile up until the timer fires, so quick edits to
 * different fields all land: { providers }, { bridge }, and plain fields
 * (read from the form) when PATCH is {}.
 */
let saveTimer = 0
let pendingPatch = {}
function save(patch = {}, { quiet = false } = {}) {
  if (patch.providers) {
    pendingPatch.providers ??= {}
    for (const [id, value] of Object.entries(patch.providers)) {
      pendingPatch.providers[id] = { ...pendingPatch.providers[id], ...value }
      settings.providers[id] = { ...settings.providers[id], ...value }
    }
  }
  if (patch.bridge) {
    pendingPatch.bridge = { ...pendingPatch.bridge, ...patch.bridge }
    settings.bridge = { ...settings.bridge, ...patch.bridge }
  }
  if (!patch.providers && !patch.bridge) pendingPatch.plain = true
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const { plain, providers, bridge } = pendingPatch
    pendingPatch = {}
    settings = await saveSettings({
      ...(plain ? collectPlain() : {}),
      ...(providers ? { providers } : {}),
      ...(bridge ? { bridge } : {}),
    })
    if (!quiet) toast('Saved')
  }, 350)
}

async function flush() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = 0
  const { plain, providers, bridge } = pendingPatch
  pendingPatch = {}
  settings = await saveSettings({
    ...(plain ? collectPlain() : {}),
    ...(providers ? { providers } : {}),
    ...(bridge ? { bridge } : {}),
  })
}

function collectPlain() {
  return {
    language: $('language').value,
    translateTo: $('translateTo').value,
    theme: $('theme').value,
    maxPageChars: Math.max(4000, Number($('maxPageChars').value) || DEFAULTS.maxPageChars),
    pageContext: $('pageContext').checked,
    selectionToolbar: $('selectionToolbar').checked,
    sendOnEnter: $('sendOnEnter').checked,
    saveHistory: $('saveHistory').checked,
    toolbarBlocklist: $('toolbarBlocklist')
      .value.split(/\s+/)
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean),
    systemPrompt: $('systemPrompt').value,
    customActions: settings.customActions,
  }
}

/* ---------- provider cards ---------- */

function input(id, key, { label, type = 'text', placeholder = '', mono = false, value }) {
  const val = value ?? settings.providers[id]?.[key] ?? ''
  const field = `<input class="input${mono ? ' mono' : ''}" type="${type}" data-field="${id}.${key}" value="${esc(val)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">`
  if (type === 'password') {
    return `<label class="field"><span>${esc(label)}</span><div class="with-btn">${field}<button type="button" class="icon-btn" data-reveal title="Show" aria-label="Show">${icon('eye', 15)}</button></div></label>`
  }
  return `<label class="field"><span>${esc(label)}</span>${field}</label>`
}

function bodyFor(p) {
  const cfg = settings.providers[p.id] ?? {}
  switch (p.id) {
    case 'claude-web':
      return `<label class="row compact"><span><strong>Keep ChroMind's chats in your claude.ai history</strong><small>Off: they're temporary and deleted when you start a new chat.</small></span>
        <span class="switch"><input type="checkbox" data-field="claude-web.keepHistory" ${cfg.keepHistory !== false ? 'checked' : ''}><span class="track"></span></span></label>`
    case 'hermes': {
      const server = cfg.server
      return `<div class="grid two">
          ${input('hermes', 'address', { label: 'Server', placeholder: 'you@100.x.y.z or t3lluz.com', mono: true })}
          ${input('hermes', 'password', { label: 'Password', type: 'password', placeholder: 'Only for Hermes: its API_SERVER_KEY' })}
        </div>
        <div class="connect-row">
          <button type="button" class="btn primary" data-connect>${server ? 'Connect again' : 'Connect'}</button>
          ${server ? `<button type="button" class="btn" data-forget>Forget</button>` : ''}
          <span class="status" data-connect-status>${
            server
              ? `<span class="ok">${esc(server.kind === 'dashboard' ? `Your dashboard on ${server.label}` : `Hermes on ${server.label}`)}</span>`
              : ''
          }</span>
        </div>
        <div class="fix-box" data-fix hidden></div>
        ${
          server?.kind === 'hermes'
            ? `<details class="advanced"><summary>Hermes options</summary><div class="grid two">
                ${input('hermes', 'profile', { label: 'Profile (optional)', placeholder: 'browser' })}
                ${input('hermes', 'sessionKey', { label: 'Memory key', placeholder: 'chromind' })}
              </div></details>`
            : ''
        }`
    }
    case 'opencode':
      return `${input('opencode', 'zenKey', { label: 'OpenCode Zen key (optional)', type: 'password', placeholder: 'Leave empty for the free models' })}
        <p class="hint">${cfg.zenKey ? 'With a Zen key every OpenCode model answers directly, no app needed.' : "Without a key, OpenCode's free models answer through the OpenCode app on this computer (free to install) and ChroMind Bridge."}</p>`
    case 'claude-code':
      return `<p class="hint">Uses the Claude Code app, signed in with <code>claude auth login</code>, through <a href="#bridge">ChroMind Bridge</a>. Its tools are off: it only answers.</p>`
    case 'cursor':
      return `<p class="hint">Uses the Cursor app (<code>cursor-agent</code>), signed in with <code>cursor-agent login</code>, through <a href="#bridge">ChroMind Bridge</a>. Read-only.</p>`
    case 'custom':
      return `<div class="grid two">
          ${input('custom', 'baseUrl', { label: 'Server URL', placeholder: 'http://127.0.0.1:11434', mono: true })}
          ${input('custom', 'apiKey', { label: 'API key (if it needs one)', type: 'password' })}
        </div>
        <label class="field"><span>Model</span><div class="with-btn"><input class="input mono" data-field="custom.model" list="customModels" value="${esc(cfg.model ?? '')}" placeholder="llama3.2" spellcheck="false"><button type="button" class="btn" data-load-models>Load</button></div><datalist id="customModels"></datalist></label>`
    default:
      return input(p.id, 'apiKey', { label: 'API key', type: 'password', placeholder: 'Paste your key' })
  }
}

function cardHTML(p) {
  const inUse = settings.provider === p.id
  const access = ACCESS[p.access]
  const keyLink = p.keyUrl
    ? `<a class="btn ghost" href="${p.keyUrl}" target="_blank" rel="noopener">${icon('external', 14)}Get a key</a>`
    : p.id === 'claude-web'
      ? `<a class="btn ghost" href="https://claude.ai/login" target="_blank" rel="noopener">${icon('external', 14)}Sign in</a>`
      : ''
  return `<article class="pcard${inUse ? ' in-use' : ''}" id="provider-${p.id}" data-provider="${p.id}">
      <header class="pcard-head">
        <span class="pcard-logo">${logo(p.brand, 22)}</span>
        <div class="pcard-title"><strong>${esc(p.name)}</strong><span class="access access-${access.tone}">${esc(access.label)}</span></div>
        <span class="pcard-state" data-state><span class="dot"></span><span>Checking</span></span>
      </header>
      <p class="pcard-blurb">${esc(p.blurb)}</p>
      <div class="pcard-body">${bodyFor(p)}</div>
      <footer class="pcard-foot">
        ${inUse ? '<span class="in-use-tag">In use</span>' : `<button type="button" class="btn" data-use>Use</button>`}
        <button type="button" class="btn ghost" data-test>Test</button>
        ${keyLink}
        <span class="status" data-status></span>
      </footer>
    </article>`
}

function renderProviders() {
  $('providerList').innerHTML = PROVIDERS.map(cardHTML).join('')
  hydrateIcons($('providerList'))
  refreshStates()
}

async function refreshStates({ fresh = false } = {}) {
  await Promise.all(
    PROVIDERS.map(async (p) => {
      const card = document.getElementById(`provider-${p.id}`)
      const state = card?.querySelector('[data-state]')
      if (!state) return
      const { ready, note } = await isReady(p.id, settings, { fresh })
      state.className = `pcard-state ${ready ? 'ready' : 'off'}`
      state.innerHTML = `<span class="dot"></span><span>${esc(ready ? 'Ready' : note)}</span>`
    }),
  )
}

function setStatus(card, text, ok) {
  const el = card.querySelector('[data-status]')
  el.textContent = text
  el.className = `status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`
}

async function connectServer(card) {
  await flush()
  const status = card.querySelector('[data-connect-status]')
  const fixBox = card.querySelector('[data-fix]')
  const button = card.querySelector('[data-connect]')
  const { address, password } = settings.providers.hermes
  fixBox.hidden = true
  button.disabled = true
  status.textContent = ''
  status.append(globalThis.CMScanner.create({ size: 4, gap: 2 }), ' Looking for Hermes and your dashboard')
  try {
    const server = await detectServer({ address, password })
    settings = await saveSettings({ providers: { hermes: { server, model: '' } } })
    if (settings.provider !== 'hermes') settings = await saveSettings({ provider: 'hermes' })
    renderProviders()
    const fresh = document.getElementById('provider-hermes')
    const { groups } = await providerModels('hermes', settings, { fresh: true })
    setStatus(fresh, `Connected · ${groups.length} model${groups.length === 1 ? '' : 's'}`, true)
  } catch (err) {
    button.disabled = false
    status.innerHTML = `<span class="bad">${esc(err.message)}</span>`
    if (err.fix) {
      fixBox.hidden = false
      fixBox.innerHTML = `<p>${esc(err.fix)}</p><div class="cmd"><code>API_SERVER_HOST=0.0.0.0</code><button type="button" class="icon-btn sm ghost" data-copy="API_SERVER_HOST=0.0.0.0" title="Copy">${icon('copy', 14)}</button></div>`
    }
  }
}

async function useProvider(id) {
  await flush()
  settings = await saveSettings({ provider: id })
  const cfg = settings.providers[id] ?? {}
  // Key and URL providers need a model; take the first one they list.
  if (!cfg.model && ['key', 'url'].includes(getProvider(id).access)) {
    const { groups } = await providerModels(id, settings)
    const first = groups[0]?.variants[0]?.id
    if (first) settings = await saveSettings({ providers: { [id]: { model: first } } })
  }
  renderProviders()
  toast(`${getProvider(id).name} answers now`)
}

function bindProviders() {
  const list = $('providerList')
  list.addEventListener('input', (e) => {
    const field = e.target.dataset.field
    if (!field || e.target.type === 'checkbox') return
    const [id, key] = field.split('.')
    const patch = { [key]: e.target.value.trim() }
    // A new address is a new server: connect again (now, or on first use).
    if (field === 'hermes.address' && settings.providers.hermes.server) {
      patch.server = null
      const status = e.target.closest('.pcard')?.querySelector('[data-connect-status]')
      if (status) status.textContent = ''
    }
    save({ providers: { [id]: patch } }, { quiet: true })
  })
  list.addEventListener('change', (e) => {
    const field = e.target.dataset.field
    if (!field) return
    const [id, key] = field.split('.')
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim()
    save({ providers: { [id]: { [key]: value } } })
    if (key === 'apiKey' || key === 'zenKey' || key === 'baseUrl') setTimeout(() => refreshStates(), 500)
  })
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('#provider-hermes') && e.target.matches('input')) {
      e.preventDefault()
      connectServer(document.getElementById('provider-hermes'))
    }
  })
  list.addEventListener('click', async (e) => {
    const card = e.target.closest('[data-provider]')
    if (!card) return
    const id = card.dataset.provider
    const reveal = e.target.closest('[data-reveal]')
    if (reveal) {
      const field = reveal.parentElement.querySelector('input')
      field.type = field.type === 'password' ? 'text' : 'password'
      reveal.title = field.type === 'password' ? 'Show' : 'Hide'
      reveal.setAttribute('aria-pressed', String(field.type === 'text'))
      return
    }
    if (e.target.closest('[data-connect]')) return connectServer(card)
    if (e.target.closest('[data-forget]')) {
      settings = await saveSettings({ providers: { hermes: { server: null, model: '' } } })
      return renderProviders()
    }
    if (e.target.closest('[data-use]')) return useProvider(id)
    if (e.target.closest('[data-load-models]')) {
      await flush()
      const { groups, error } = await providerModels('custom', settings, { fresh: true })
      $('customModels').innerHTML = groups.flatMap((g) => g.variants).map((v) => `<option value="${esc(v.id)}">`).join('')
      return setStatus(card, error ? error.message : `${groups.length} models`, !error)
    }
    if (e.target.closest('[data-test]')) {
      await flush()
      setStatus(card, 'Testing…')
      try {
        setStatus(card, await testProvider(id, settings), true)
      } catch (err) {
        setStatus(card, err.message, false)
      }
      refreshStates({ fresh: true })
    }
  })
}

/* ---------- bridge ---------- */

async function checkBridge(fresh = true) {
  const box = $('bridgeStatus')
  box.innerHTML = ''
  box.append(globalThis.CMScanner.create({ size: 4, gap: 2 }))
  const { value, error } = await bridgeApps(settings, { fresh })
  if (!value) {
    box.innerHTML = `<span class="pill bad">Not running</span><span class="status">${esc(
      error?.message ?? 'Start it with the command below.',
    )}</span>`
    return
  }
  const app = (id, name, brand) => {
    const a = value.providers?.[id]
    const state = !a?.installed ? 'not installed' : a.loggedIn === false ? 'not signed in' : a.version || 'ready'
    const ok = a?.installed && a.loggedIn !== false
    return `<span class="app-chip ${ok ? 'ok' : 'off'}">${logo(brand, 16)}<strong>${name}</strong><small>${esc(state)}</small></span>`
  }
  box.innerHTML = `<span class="pill ok">Running · paired · ${esc(value.version ?? '')}</span>
    <div class="apps">${app('claude-code', 'Claude Code', 'claude')}${app('cursor', 'Cursor', 'cursor')}${app('opencode', 'OpenCode', 'opencode')}</div>`
}

function bindBridge() {
  $('bridgeUrl').value = settings.bridge.url
  $('bridgeUrl').addEventListener('change', () => {
    save({ bridge: { url: $('bridgeUrl').value.trim() || DEFAULTS.bridge.url, token: '' } })
    setTimeout(() => checkBridge(), 500)
  })
  $('bridgeCheck').addEventListener('click', async () => {
    await checkBridge()
    refreshStates({ fresh: true })
  })
}

/* ---------- behavior ---------- */

function bindBehavior() {
  $('language').innerHTML =
    '<option value="auto">Same as my question</option>' + LANGUAGES.map((l) => `<option>${l}</option>`).join('')
  $('translateTo').innerHTML = LANGUAGES.map((l) => `<option>${l}</option>`).join('')
  $('language').value = settings.language
  $('translateTo').value = settings.translateTo
  $('theme').value = settings.theme
  $('maxPageChars').value = settings.maxPageChars
  $('pageContext').checked = settings.pageContext
  $('selectionToolbar').checked = settings.selectionToolbar
  $('sendOnEnter').checked = settings.sendOnEnter
  $('saveHistory').checked = settings.saveHistory
  $('toolbarBlocklist').value = settings.toolbarBlocklist.join('\n')
  $('systemPrompt').value = settings.systemPrompt
  for (const id of ['language', 'translateTo', 'theme', 'maxPageChars', 'pageContext', 'selectionToolbar', 'sendOnEnter', 'saveHistory', 'toolbarBlocklist', 'systemPrompt']) {
    $(id).addEventListener('change', () => {
      save({})
      if (id === 'theme') applyTheme($('theme').value)
    })
  }
}

/* ---------- custom actions ---------- */

const SCOPES = [
  ['page', 'Page'],
  ['selection', 'Selection'],
  ['youtube', 'Video'],
  ['link', 'Link'],
  ['tabs', 'Tabs'],
]

function renderActions() {
  const actions = settings.customActions
  $('customActions').innerHTML = actions.length
    ? actions
        .map(
          (a, i) => `<div class="custom-action" data-index="${i}">
        <div class="custom-action-top"><input class="input" data-k="title" value="${esc(a.title)}" placeholder="Name">
          <button type="button" class="icon-btn" data-remove="${i}" title="Delete">${icon('trash', 15)}</button></div>
        <textarea class="textarea" data-k="prompt" rows="2" placeholder="Summarize {{target}} for a busy reader.">${esc(a.prompt)}</textarea>
        <div class="scopes">${SCOPES.map(
          ([id, label]) =>
            `<label class="scope"><input type="checkbox" data-scope="${id}" ${(a.scopes ?? []).includes(id) ? 'checked' : ''}>${label}</label>`,
        ).join('')}</div></div>`,
        )
        .join('')
    : '<p class="empty">No actions of your own yet.</p>'
}

function bindActions() {
  const box = $('customActions')
  const update = (e) => {
    const card = e.target.closest('[data-index]')
    if (!card) return
    const a = settings.customActions[Number(card.dataset.index)]
    if (e.target.dataset.k) a[e.target.dataset.k] = e.target.value
    if (e.target.dataset.scope) a.scopes = [...card.querySelectorAll('[data-scope]:checked')].map((c) => c.dataset.scope)
    save({}, { quiet: true })
  }
  box.addEventListener('input', update)
  box.addEventListener('change', update)
  box.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]')
    if (!remove) return
    settings.customActions.splice(Number(remove.dataset.remove), 1)
    renderActions()
    save({})
  })
  $('addAction').addEventListener('click', () => {
    settings.customActions.push({ id: `custom-${crypto.randomUUID().slice(0, 8)}`, title: '', prompt: '', scopes: ['page', 'selection'] })
    renderActions()
    box.querySelector('.custom-action:last-child input')?.focus()
  })
}

/* ---------- shortcuts, data, permissions ---------- */

async function renderShortcuts() {
  const commands = await api.commands.getAll()
  const names = {
    _execute_action: 'Open ChroMind',
    _execute_sidebar_action: 'Open ChroMind',
    'summarize-page': 'Summarize the page',
    'explain-selection': 'Explain the selection',
  }
  $('shortcutList').innerHTML = commands
    .map(
      (c) =>
        `<div class="shortcut"><span>${esc(names[c.name] ?? c.description ?? c.name)}</span>${
          c.shortcut ? c.shortcut.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join(' ') : '<span class="status">Not set</span>'
        }</div>`,
    )
    .join('')
  $('shortcutBtn').addEventListener('click', async () => {
    if (api.commands.openShortcutSettings) return api.commands.openShortcutSettings()
    if (!isFirefox) return api.tabs.create({ url: 'chrome://extensions/shortcuts' })
    $('shortcutHint').textContent = 'Open about:addons, click the gear, then Manage Extension Shortcuts.'
  })
}

function bindData() {
  $('exportSettings').addEventListener('click', async () => {
    const data = JSON.stringify(await getSettings(), null, 2)
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([data], { type: 'application/json' })),
      download: 'chromind-settings.json',
    })
    a.click()
  })
  $('importSettings').addEventListener('change', async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      await api.storage.local.set({ settings: data })
      toast('Settings imported')
      setTimeout(() => location.reload(), 600)
    } catch {
      toast('That file is not ChroMind settings')
    }
  })
  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('Delete all saved ChroMind chats on this device?')) return
    await clearThreads()
    toast('Chats deleted')
  })
}

async function checkPermissions() {
  const has = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true)
  $('permissionBox').hidden = has
  $('grantBtn').onclick = async () => {
    const granted = await api.permissions.request({ origins: ['<all_urls>'] }).catch(() => false)
    $('permissionBox').hidden = granted
    if (granted) toast('Access granted')
  }
}

function bindChrome() {
  $('versionPill').textContent = `v${version}`
  const themes = ['system', 'dark', 'light']
  const themeIcon = () => {
    $('themeBtn').innerHTML = icon(settings.theme === 'light' ? 'sun' : settings.theme === 'dark' ? 'moon' : 'settings', 16)
    $('themeBtn').title = `Theme: ${settings.theme}`
  }
  themeIcon()
  $('themeBtn').addEventListener('click', async () => {
    const next = themes[(themes.indexOf(settings.theme) + 1) % themes.length]
    settings = await saveSettings({ theme: next })
    $('theme').value = next
    applyTheme(next)
    themeIcon()
  })
  document.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]')
    if (copy) {
      await navigator.clipboard.writeText(copy.dataset.copy)
      toast('Copied')
    }
  })
  const links = [...document.querySelectorAll('.side a')]
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        for (const a of links) a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`)
      }
    },
    { rootMargin: '-90px 0px -60% 0px' },
  )
  for (const section of document.querySelectorAll('main section')) spy.observe(section)
}

async function init() {
  settings = await getSettings()
  applyTheme(settings.theme)
  hydrateIcons()
  bindChrome()
  renderProviders()
  bindProviders()
  bindBridge()
  bindBehavior()
  renderActions()
  bindActions()
  bindData()
  renderShortcuts()
  checkPermissions()
  checkBridge(false)
  const hash = location.hash.slice(1)
  if (hash) {
    const target = document.getElementById(hash === 'welcome' ? 'providers' : hash)
    target?.scrollIntoView({ block: 'start' })
    target?.classList.add('flash')
  }
}

init()
