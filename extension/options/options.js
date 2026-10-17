import { api, isFirefox, version } from '../lib/browser.js'
import { clearThreads } from '../lib/history.js'
import { icon } from '../lib/icons.js'
import { CLAUDE_WEB_MODELS } from '../lib/providers/claude-web.js'
import { bridgeStatus, fetchModels, PROVIDERS, testProvider } from '../lib/providers/index.js'
import { applyTheme, DEFAULTS, getSettings, saveSettings } from '../lib/settings.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => globalThis.CMMarkdown.escape(s ?? '')

const LANGUAGES = [
  'English', 'Norwegian', 'Swedish', 'Danish', 'Finnish', 'German', 'French', 'Spanish', 'Portuguese', 'Italian',
  'Dutch', 'Polish', 'Ukrainian', 'Turkish', 'Arabic', 'Hindi', 'Japanese', 'Korean', 'Chinese (Simplified)',
  'Chinese (Traditional)',
]

const PROVIDER_ICONS = { 'claude-web': 'spark', 'claude-code': 'bridge', cursor: 'bridge', hermes: 'server', custom: 'server' }

const NOTES = {
  'claude-web':
    'Uses the claude.ai login in this browser, nothing else to set up. Chats appear in your claude.ai history as “ChroMind · …” unless you turn that off.',
  'claude-code':
    'Runs the Claude Code CLI on your computer through ChroMind Bridge, on your Claude subscription. Tools are switched off: it only answers.',
  cursor:
    'Runs the Cursor CLI (cursor-agent) through ChroMind Bridge, signed in with your Cursor account, in read-only ask mode.',
  hermes:
    'Same login as TileSmith and DailyDash: `you@your-server` and the SSH password. ChroMind Bridge opens a tunnel to Hermes on that machine (API on localhost:8642). For Hermes on this PC, use `http://127.0.0.1:8642` and put API_SERVER_KEY in Password instead. Page text is untrusted — prefer a browsing profile with limited tools.',
  custom:
    'Any /v1/chat/completions server: Ollama (http://127.0.0.1:11434), LM Studio (http://127.0.0.1:1234), OpenRouter (https://openrouter.ai/api).',
}

const FIELDS = {
  'claude-web': [
    { key: 'model', label: 'Model', type: 'select', options: CLAUDE_WEB_MODELS },
    { key: 'keepHistory', label: 'Keep ChroMind chats in my claude.ai history', type: 'switch' },
  ],
  'claude-code': [
    { key: 'model', label: 'Model', type: 'select', options: PROVIDERS.find((p) => p.id === 'claude-code').models },
  ],
  cursor: [{ key: 'model', label: 'Model', type: 'text', placeholder: 'auto', list: true }],
  hermes: [
    { key: 'address', label: 'Address', type: 'text', mono: true, placeholder: 'you@100.x.y.z or http://127.0.0.1:8642' },
    { key: 'password', label: 'Password', type: 'password', mono: true, placeholder: 'SSH password (or API key for a URL)' },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'hermes-agent', list: true },
    { key: 'profile', label: 'Profile (optional)', type: 'text', placeholder: 'browser' },
    { key: 'sessionKey', label: 'Memory key', type: 'text', placeholder: 'chromind' },
  ],
  custom: [
    { key: 'name', label: 'Name', type: 'text', placeholder: 'Ollama' },
    { key: 'baseUrl', label: 'Server URL', type: 'text', mono: true, placeholder: 'http://127.0.0.1:11434' },
    { key: 'apiKey', label: 'API key (if needed)', type: 'password', mono: true },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'llama3.2', list: true },
  ],
}

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

/* ---------- providers ---------- */

function fieldHTML(id, f, cfg) {
  const value = cfg[f.key] ?? ''
  const name = `${id}.${f.key}`
  if (f.type === 'switch') {
    return `<label class="row" style="border:1px solid var(--border);border-radius:12px"><span><strong>${esc(f.label)}</strong></span>
      <span class="switch"><input type="checkbox" data-field="${name}" ${value !== false ? 'checked' : ''}><span class="track"></span></span></label>`
  }
  if (f.type === 'select') {
    return `<label class="field"><span>${esc(f.label)}</span><select class="select" data-field="${name}">${f.options
      .map((o) => `<option value="${esc(o.id)}" ${o.id === value ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('')}</select></label>`
  }
  const list = f.list ? `list="list-${id}"` : ''
  const input = `<input class="input${f.mono ? ' mono' : ''}" type="${f.type}" data-field="${name}" value="${esc(value)}" placeholder="${esc(f.placeholder ?? '')}" spellcheck="false" autocomplete="off" ${list}>`
  if (f.type === 'password') {
    return `<label class="field"><span>${esc(f.label)}</span><div class="with-btn">${input}<button type="button" class="icon-btn" data-reveal-field="${name}" title="Show">${icon('search', 15)}</button></div></label>`
  }
  return `<label class="field"><span>${esc(f.label)}</span>${input}${f.list ? `<datalist id="list-${id}"></datalist>` : ''}</label>`
}

function renderProviders() {
  $('providerList').innerHTML = PROVIDERS.map((p) => {
    const cfg = settings.providers[p.id] ?? {}
    const fields = FIELDS[p.id] ?? []
    const wide = fields.length > 2 ? 'grid two' : 'grid'
    const canFetch = fields.some((f) => f.list)
    return `<article class="provider${settings.provider === p.id ? ' is-default' : ''}" data-provider="${p.id}">
      <label class="provider-head">
        <input type="radio" name="defaultProvider" value="${p.id}" ${settings.provider === p.id ? 'checked' : ''} aria-label="Use ${esc(p.name)} by default">
        <span class="provider-icon">${icon(PROVIDER_ICONS[p.id], 18)}</span>
        <span class="provider-copy"><strong>${esc(p.id === 'custom' && cfg.name ? cfg.name : p.name)}</strong><small>${esc(p.detail)}</small></span>
        ${settings.provider === p.id ? '<span class="pill">Default</span>' : ''}
      </label>
      <div class="provider-body">
        <p class="hint">${esc(NOTES[p.id]).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>
        <div class="${wide}">${fields.map((f) => fieldHTML(p.id, f, cfg)).join('')}</div>
        <div class="provider-foot">
          <button type="button" class="btn" data-test="${p.id}">${icon('check', 15)}Test</button>
          ${canFetch ? `<button type="button" class="btn" data-fetch="${p.id}">${icon('refresh', 15)}Load models</button>` : ''}
          ${p.id === 'claude-web' ? `<a class="btn" href="https://claude.ai/login" target="_blank" rel="noopener">${icon('external', 15)}Sign in to claude.ai</a>` : ''}
          ${p.bridge ? `<a class="btn" href="#bridge">${icon('bridge', 15)}Bridge setup</a>` : ''}
          <span class="status" data-status="${p.id}"></span>
        </div>
      </div>
    </article>`
  }).join('')
}

function setStatus(id, text, ok) {
  const el = document.querySelector(`[data-status="${id}"]`)
  if (!el) return
  el.textContent = text
  el.className = `status ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`
}

function bindProviders() {
  const list = $('providerList')
  list.addEventListener('change', (e) => {
    const t = e.target
    if (t.name === 'defaultProvider') {
      settings.provider = t.value
      saveSettings({ provider: t.value }).then((s) => {
        settings = s
        renderProviders()
        toast('Default provider saved')
      })
      return
    }
    if (t.dataset.field) saveField(t)
  })
  list.addEventListener('input', (e) => {
    if (e.target.dataset.field && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') saveField(e.target, true)
  })
  list.addEventListener('click', async (e) => {
    const reveal = e.target.closest('[data-reveal-field]')
    if (reveal) {
      const input = list.querySelector(`[data-field="${reveal.dataset.revealField}"]`)
      input.type = input.type === 'password' ? 'text' : 'password'
      return
    }
    const test = e.target.closest('[data-test]')
    if (test) {
      const id = test.dataset.test
      setStatus(id, 'Testing…')
      try {
        setStatus(id, await testProvider(id, await getSettings()), true)
      } catch (err) {
        setStatus(id, err.message, false)
      }
      return
    }
    const fetchBtn = e.target.closest('[data-fetch]')
    if (fetchBtn) {
      const id = fetchBtn.dataset.fetch
      setStatus(id, 'Loading models…')
      try {
        const models = await fetchModels(id, await getSettings())
        const datalist = $(`list-${id}`)
        if (datalist) datalist.innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('')
        setStatus(id, models.length ? `${models.length} models: pick one in the Model field` : 'No models listed', true)
      } catch (err) {
        setStatus(id, err.message, false)
      }
    }
  })
}

function saveField(input, quiet = false) {
  const [id, key] = input.dataset.field.split('.')
  const value = input.type === 'checkbox' ? input.checked : input.value.trim()
  settings.providers[id] = { ...settings.providers[id], [key]: value }
  save({ providers: { [id]: { [key]: value } } }, { quiet })
  if (quiet) toastSoon()
}

let quietTimer = 0
function toastSoon() {
  clearTimeout(quietTimer)
  quietTimer = setTimeout(() => toast('Saved'), 900)
}

/* ---------- bridge ---------- */

async function checkBridge() {
  const box = $('bridgeStatus')
  box.innerHTML = '<span class="pill muted">Checking…</span>'
  try {
    const status = await bridgeStatus(await getSettings())
    const cli = (id, name) => {
      const c = status.providers?.[id]
      if (!c?.installed) return `<span class="pill bad">${name}: not found</span>`
      if (c.loggedIn === false) return `<span class="pill bad">${name}: not signed in</span>`
      return `<span class="pill ok">${name} ${esc(c.version ?? '')}</span>`
    }
    box.innerHTML = `<span class="pill ok">Bridge ${esc(status.version ?? '')}</span>${cli('claude-code', 'Claude Code')}${cli('cursor', 'Cursor')}`
  } catch (err) {
    box.innerHTML = `<span class="pill bad">Not connected</span><span class="status">${esc(err.message)}</span>`
  }
}

function bindBridge() {
  $('bridgeUrl').value = settings.bridge.url
  $('bridgeToken').value = settings.bridge.token
  const persist = () => {
    save({ bridge: { url: $('bridgeUrl').value.trim() || DEFAULTS.bridge.url, token: $('bridgeToken').value.trim() } }, { quiet: true })
    toastSoon()
  }
  $('bridgeUrl').addEventListener('input', persist)
  $('bridgeToken').addEventListener('input', persist)
  $('bridgeToken').addEventListener('change', () => setTimeout(checkBridge, 500))
  $('bridgeCheck').addEventListener('click', checkBridge)
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
        <textarea class="textarea" data-k="prompt" rows="2" placeholder="Summarize {{target}} for a busy executive.">${esc(a.prompt)}</textarea>
        <div class="scopes">${SCOPES.map(
          ([id, label]) =>
            `<label class="scope"><input type="checkbox" data-scope="${id}" ${(a.scopes ?? []).includes(id) ? 'checked' : ''}>${label}</label>`,
        ).join('')}</div></div>`,
        )
        .join('')
    : '<p class="empty">No custom actions yet.</p>'
}

function bindActions() {
  const box = $('customActions')
  const update = (e) => {
    const card = e.target.closest('[data-index]')
    if (!card) return
    const a = settings.customActions[Number(card.dataset.index)]
    if (e.target.dataset.k) a[e.target.dataset.k] = e.target.value
    if (e.target.dataset.scope) {
      a.scopes = [...card.querySelectorAll('[data-scope]:checked')].map((c) => c.dataset.scope)
    }
    save({}, { quiet: true })
    toastSoon()
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
    'summarize-page': 'Summarize the current page',
    'explain-selection': 'Explain the selected text',
  }
  $('shortcutList').innerHTML = commands
    .map(
      (c) =>
        `<div class="shortcut"><span>${esc(names[c.name] ?? c.description ?? c.name)}</span>${
          c.shortcut ? c.shortcut.split('+').map((k) => `<kbd>${esc(k)}</kbd>`).join('+') : '<span class="status">Not set</span>'
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
    toast('Chat history deleted')
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
    const reveal = e.target.closest('[data-reveal]')
    if (reveal) {
      const input = $(reveal.dataset.reveal)
      input.type = input.type === 'password' ? 'text' : 'password'
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
  checkBridge()
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView()
}

init()
