import { api } from './browser.js'

/**
 * Settings live in storage.local (never sync: they hold server keys and the
 * Bridge token). `get()` always returns a full object: stored values merged
 * over DEFAULTS, one level deep for the per-provider blocks.
 */
export const DEFAULTS = {
  provider: 'claude-web',
  providers: {
    'claude-web': { model: '', keepHistory: true },
    'claude-code': { model: 'sonnet' },
    cursor: { model: 'auto' },
    // address: user@host (SSH via Bridge) or http://127.0.0.1:8642 (direct).
    // password: SSH password, or the Hermes API_SERVER_KEY for a direct URL.
    hermes: { address: '', password: '', model: 'hermes-agent', profile: '', sessionKey: 'chromind', apiPort: 8642 },
    custom: { name: 'Custom', baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: '' },
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

/** 0.1 stored hermes.baseUrl + apiKey; 0.2 uses address + password like TileSmith. */
function migrateHermes(cfg = {}) {
  const next = { ...cfg }
  if (!next.address && next.baseUrl) {
    next.address = next.baseUrl
    delete next.baseUrl
  }
  if (!next.password && next.apiKey) {
    next.password = next.apiKey
    delete next.apiKey
  }
  delete next.baseUrl
  delete next.apiKey
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
  if (next.providers?.hermes) next.providers.hermes = migrateHermes(next.providers.hermes)
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
