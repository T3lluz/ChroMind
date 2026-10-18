import { api } from './browser.js'

/**
 * Settings live in storage.local (never sync: they hold keys and passwords).
 * `getSettings()` always returns a full object: stored values merged over
 * DEFAULTS, one level deep for the per-provider blocks. Each provider keeps
 * its own model (and depth, as part of the model id: "opus@high").
 */
export const DEFAULTS = {
  provider: 'claude-web',
  providers: {
    'claude-web': { model: '', keepHistory: true },
    // server: what detectServer() found: { kind: 'dashboard' | 'hermes', base, label }
    hermes: { address: '', password: '', server: null, model: '', profile: '', sessionKey: 'chromind' },
    opencode: { model: 'big-pickle', zenKey: '' },
    'claude-code': { model: 'sonnet' },
    cursor: { model: 'auto' },
    openrouter: { apiKey: '', model: '' },
    gemini: { apiKey: '', model: '' },
    openai: { apiKey: '', model: '' },
    groq: { apiKey: '', model: '' },
    custom: { baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: '' },
  },
  bridge: { url: 'http://127.0.0.1:8765', token: '' },
  /** 'auto' answers in the language the user writes in. */
  language: 'auto',
  translateTo: 'English',
  pageContext: true,
  maxPageChars: 60000,
  selectionToolbar: true,
  toolbarBlocklist: [],
  theme: 'system',
  systemPrompt: '',
  sendOnEnter: true,
  saveHistory: true,
  customActions: [
    {
      id: 'custom-tldr',
      title: 'TL;DR',
      prompt: 'Give me a one-sentence TL;DR of {{target}}, then three bullet points with the most useful details.',
      scopes: ['page', 'selection'],
    },
  ],
}

const KEY = 'settings'

/**
 * Older settings: 0.1 kept Hermes as baseUrl + apiKey, 0.2 as address +
 * password through the Bridge (with apiPort). Both become address +
 * password; the server is detected again on the next Connect.
 */
function migrateHermes(cfg = {}) {
  const next = { ...cfg }
  if (!next.address && next.baseUrl) next.address = next.baseUrl
  if (!next.password && next.apiKey) next.password = next.apiKey
  delete next.baseUrl
  delete next.apiKey
  delete next.apiPort
  if (next.model === 'hermes-agent') next.model = ''
  return next
}

function merge(stored = {}) {
  const out = { ...DEFAULTS, ...stored }
  out.providers = { ...DEFAULTS.providers }
  for (const [id, value] of Object.entries(stored.providers ?? {})) {
    const merged = { ...(DEFAULTS.providers[id] ?? {}), ...value }
    out.providers[id] = id === 'hermes' ? migrateHermes(merged) : merged
  }
  out.bridge = { ...DEFAULTS.bridge, ...(stored.bridge ?? {}) }
  if (!Array.isArray(out.customActions)) out.customActions = DEFAULTS.customActions
  if (!Array.isArray(out.toolbarBlocklist)) out.toolbarBlocklist = []
  return out
}

export async function getSettings() {
  const { [KEY]: stored } = await api.storage.local.get(KEY)
  return merge(stored)
}

/** Shallow-merges PATCH into the stored settings and returns the result. */
export async function saveSettings(patch) {
  const { [KEY]: stored = {} } = await api.storage.local.get(KEY)
  const next = { ...stored, ...patch }
  if (patch.providers) {
    next.providers = { ...(stored.providers ?? {}) }
    for (const [id, value] of Object.entries(patch.providers)) {
      next.providers[id] = { ...(stored.providers?.[id] ?? {}), ...value }
    }
  }
  if (patch.bridge) next.bridge = { ...(stored.bridge ?? {}), ...patch.bridge }
  await api.storage.local.set({ [KEY]: next })
  return merge(next)
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[KEY]) callback(merge(changes[KEY].newValue))
  }
  api.storage.onChanged.addListener(listener)
  return () => api.storage.onChanged.removeListener(listener)
}

/** Resolves 'system' to the theme the browser prefers. */
export function applyTheme(theme, root = document.documentElement) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.dataset.theme = dark ? 'dark' : 'light'
}
