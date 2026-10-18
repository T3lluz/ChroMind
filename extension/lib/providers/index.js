/**
 * The providers ChroMind can talk to: their model lists (for the picker),
 * whether each is ready, and runChat(), which streams an answer from the
 * selected one.
 *
 * Adding a provider: describe it in catalog.js, give it a branch in
 * loadModels(), runChat() and isReady(), and defaults in lib/settings.js.
 */
import { api } from '../browser.js'
import { saveSettings } from '../settings.js'
import { brandFor } from '../brands.js'
import { groupModels, isFree, modelTitle, prettyModel, splitVariant } from '../models.js'
import { systemPrompt, toChatMessages } from '../prompts.js'
import { bridgeStatus, bridgeToken } from './bridge.js'
import { ACCESS, CLAUDE_CODE_MODELS, CLAUDE_WEB_MODELS, getProvider, PROVIDERS } from './catalog.js'
import { sendClaudeWeb, testClaudeWeb } from './claude-web.js'
import { ProviderError } from './errors.js'
import { listModels, sendOpenAI } from './openai.js'
import { detectServer, serverChatBase, serverModels, splitServerModel } from './server.js'

export { ACCESS, bridgeStatus, detectServer, getProvider, ProviderError, PROVIDERS }

const setup = (message, action = 'settings') => new ProviderError(message, { code: 'setup', action })

/**
 * The server ChroMind connected to. With only an address saved (settings
 * from 0.2, or an address typed without pressing Connect) it connects now.
 */
async function connectedServer(settings) {
  const cfg = settings.providers.hermes
  if (cfg.server) return cfg.server
  if (!cfg.address) throw setup('Connect your server in settings first: its address and, for Hermes, its password.')
  const server = await detectServer({ address: cfg.address, password: cfg.password })
  settings.providers.hermes = { ...cfg, server }
  await saveSettings({ providers: { hermes: { server } } }).catch(() => {})
  return server
}

/* ---------- model lists ---------- */

const NOT_CHAT = /embed|tts|whisper|dall-e|imagen|image|audio|moderation|realtime|transcribe|search|guard|veo|lyria|aqa|computer-use/

/** Raw entries [{ id, label?, free?, note?, brand, source? }] for provider ID. */
async function loadModels(id, settings) {
  const provider = getProvider(id)
  const cfg = settings.providers[id] ?? {}
  switch (id) {
    case 'claude-web':
      return CLAUDE_WEB_MODELS.map((m) => ({ ...m, brand: 'claude' }))
    case 'claude-code':
      return CLAUDE_CODE_MODELS.map((m) => ({ ...m, brand: 'claude' }))
    case 'cursor': {
      const app = (await bridgeStatus(settings)).providers?.cursor
      if (!app?.installed) throw setup("The Cursor app isn't on this computer.", 'settings:bridge')
      return app.models.map((m) =>
        m === 'auto'
          ? { id: 'auto', label: 'Auto', note: 'Cursor picks', brand: 'cursor' }
          : { id: m, brand: brandFor(m, 'cursor') },
      )
    }
    case 'opencode': {
      const res = await fetch(`${provider.zenUrl}/models`, { signal: AbortSignal.timeout(10000) }).catch(() => null)
      if (!res?.ok) throw new ProviderError("Couldn't load OpenCode's models.", { code: 'offline' })
      const ids = ((await res.json()).data ?? []).map((m) => m.id)
      return ids
        .filter((m) => cfg.zenKey || isFree(m))
        .map((m) => ({ id: m, free: isFree(m), brand: brandFor(m, 'opencode') }))
        .sort((a, b) => Number(b.free) - Number(a.free))
    }
    case 'hermes': {
      const server = await connectedServer(settings)
      const ids = await serverModels(server, cfg.password)
      if (server.kind === 'hermes') {
        return ids.map((m) => ({ id: m, label: m === 'hermes-agent' ? 'Hermes Agent' : prettyModel(m), brand: 'nousresearch' }))
      }
      return [
        { id: '', label: 'Hermes', note: "The model Hermes uses", brand: 'nousresearch' },
        ...ids.map((m) => {
          const { source, model } = splitServerModel(m)
          const fallback = source === 'cursor' ? 'cursor' : source === 'opencode' ? 'opencode' : 'claude'
          return {
            id: m,
            source,
            familyLabel: model === 'auto' ? 'Cursor Auto' : prettyModel(splitVariant(model).family),
            free: isFree(model),
            brand: model === 'auto' ? 'cursor' : brandFor(model, fallback),
          }
        }),
      ]
    }
    case 'custom': {
      if (!cfg.baseUrl) throw setup('Add your server URL first.')
      const ids = await listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
      return ids.map((m) => ({ id: m, brand: brandFor(m, cfg.baseUrl.includes(':1234') ? 'lmstudio' : 'ollama') }))
    }
    default: {
      if (!cfg.apiKey) throw setup(`Add your ${provider.name} key first.`)
      const ids = await listModels({ baseUrl: provider.baseUrl, apiKey: cfg.apiKey, headers: provider.headers })
      return ids
        .map((m) => m.replace(/^models\//, ''))
        .filter((m) => !NOT_CHAT.test(m))
        .map((m) => ({ id: m, free: isFree(m), brand: brandFor(m, provider.brand) }))
        .sort((a, b) => Number(b.free) - Number(a.free))
    }
  }
}

const TTL = 6 * 3600e3
const memory = new Map()

function cacheKey(id, settings) {
  const cfg = settings.providers[id] ?? {}
  const scope = id === 'hermes' ? (cfg.server?.base ?? cfg.address) :id === 'opencode' ? (cfg.zenKey ? 'zen' : 'free') : cfg.baseUrl || ''
  return `models:${id}:${scope ?? ''}`
}

/**
 * Model families for provider ID ({ groups, error }), from memory, then
 * storage (6 h), then the provider. FRESH skips the caches.
 */
export async function providerModels(id, settings, { fresh = false } = {}) {
  const provider = getProvider(id)
  const key = cacheKey(id, settings)
  const shape = (entries) => groupModels(entries, { depths: provider.depths })
  if (!fresh) {
    const hit = memory.get(key)
    if (hit) return { groups: shape(hit), cached: true }
    const stored = (await api.storage?.local.get(key).catch(() => ({})))?.[key]
    if (stored && Date.now() - stored.at < TTL) {
      memory.set(key, stored.list)
      return { groups: shape(stored.list), cached: true }
    }
  }
  try {
    const list = await loadModels(id, settings)
    memory.set(key, list)
    api.storage?.local.set({ [key]: { at: Date.now(), list } }).catch(() => {})
    return { groups: shape(list) }
  } catch (err) {
    const stale = (await api.storage?.local.get(key).catch(() => ({})))?.[key]
    return { groups: stale ? shape(stale.list) : [], error: err }
  }
}

/** Synchronous best guess from memory, for labels. */
function knownGroups(id, settings) {
  const list = memory.get(cacheKey(id, settings))
  if (list) return groupModels(list, { depths: getProvider(id).depths })
  if (id === 'claude-web') return groupModels(CLAUDE_WEB_MODELS)
  if (id === 'claude-code') return groupModels(CLAUDE_CODE_MODELS, { depths: getProvider(id).depths })
  return []
}

/** Warms the label cache from storage (call once at startup). */
export async function warmLabels(settings) {
  const keys = PROVIDERS.map((p) => cacheKey(p.id, settings))
  const stored = (await api.storage?.local.get(keys).catch(() => ({}))) ?? {}
  for (const [key, value] of Object.entries(stored)) if (value?.list) memory.set(key, value.list)
}

/** { name, model, full, brand } for pills and message footers. */
export function providerLabel(settings, id = settings.provider) {
  const provider = getProvider(id)
  const cfg = settings.providers[provider.id] ?? {}
  const modelId = cfg.model ?? ''
  const groups = knownGroups(provider.id, settings)
  let model = modelTitle(groups, modelId)
  if (provider.id === 'claude-web' && !modelId) model = ''
  if (provider.id === 'hermes' && !modelId) model = cfg.server?.kind === 'dashboard' ? "Hermes' model" : ''
  const family = groups.find((g) => g.variants.some((v) => v.id === modelId))
  const brand = family?.brand || (modelId ? brandFor(modelId, provider.brand) : provider.brand)
  const name = provider.id === 'hermes' && cfg.server?.label ? cfg.server.label : provider.name
  return { name, model, full: model ? `${model}` : name, brand, provider: provider.name }
}

/* ---------- readiness ---------- */

let bridgeCache = { at: 0, value: null, error: null }
let bridgeCheck = null

/** The Bridge's status, cached for 30 s; null when it isn't running. */
export async function bridgeApps(settings, { fresh = false } = {}) {
  if (!fresh && Date.now() - bridgeCache.at < 30000) return bridgeCache
  // Claude Code, Cursor and OpenCode ask at once: one request answers all three.
  if (bridgeCheck && !fresh) return bridgeCheck
  const run = bridgeStatus(settings, { fresh }).then(
    (value) => ({ at: Date.now(), value, error: null }),
    (error) => ({ at: Date.now(), value: null, error }),
  )
  bridgeCheck = run
  bridgeCache = await run
  if (bridgeCheck === run) bridgeCheck = null
  return bridgeCache
}

/**
 * Whether provider ID can answer now: { ready, note }. NOTE says what's
 * missing ("Add a key", "Start the Bridge") or what it runs on.
 */
export async function isReady(id, settings, { fresh = false } = {}) {
  const cfg = settings.providers[id] ?? {}
  const provider = getProvider(id)
  if (id === 'claude-web') return { ready: true, note: 'Uses your claude.ai login' }
  if (id === 'hermes') {
    if (cfg.server) return { ready: true, note: cfg.server.label }
    return cfg.address ? { ready: true, note: 'Connects when you use it' } : { ready: false, note: 'Connect your server' }
  }
  if (id === 'custom') return cfg.baseUrl && cfg.model ? { ready: true, note: cfg.baseUrl } : { ready: false, note: 'Add your server URL' }
  if (provider.access === 'key') return cfg.apiKey ? { ready: true, note: 'API key' } : { ready: false, note: 'Add an API key' }
  if (id === 'opencode' && cfg.zenKey) return { ready: true, note: 'OpenCode Zen key' }
  const bridge = await bridgeApps(settings, { fresh })
  if (!bridge.value) return { ready: false, note: 'Needs ChroMind Bridge' }
  const app = bridge.value.providers?.[id]
  if (!app?.installed) return { ready: false, note: `${provider.name} app not found` }
  if (app.loggedIn === false) return { ready: false, note: app.hint || 'Not signed in' }
  return { ready: true, note: id === 'opencode' ? 'Free models, through the OpenCode app' : `${provider.name} ${app.version ?? ''}`.trim() }
}

/* ---------- chatting ---------- */

/** Messages a provider should see: no failed turns, up to the last user message. */
export function sendableMessages(messages) {
  const out = messages.filter((m) => !m.error && (m.role === 'user' || m.text))
  while (out.length && out.at(-1).role !== 'user') out.pop()
  return out
}

async function viaBridge(settings, model, chat, signal, emit) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await bridgeToken(settings, { fresh: attempt > 0 })
    try {
      return await sendOpenAI({ label: 'ChroMind Bridge', baseUrl: settings.bridge.url, apiKey: token, model, messages: chat, signal, emit })
    } catch (err) {
      // A restarted Bridge with a new token: pair again, once.
      if (attempt === 0 && err?.code === 'setup' && /rejected the key/.test(err.message)) continue
      if (err?.code === 'offline') throw await bridgeDown(settings)
      throw err
    }
  }
}

async function bridgeDown(settings) {
  try {
    await bridgeToken(settings, { fresh: true })
  } catch (err) {
    return err
  }
  return new ProviderError("ChroMind Bridge didn't answer.", { code: 'offline', action: 'settings:bridge' })
}

/**
 * Streams an answer to the last user message in THREAD.messages.
 * EMIT receives { type: 'text' | 'reasoning' | 'tool' | 'meta', … }.
 * Resolves to { providerState } for providers that keep server-side state.
 */
export async function runChat({ thread, settings, signal, emit }) {
  const provider = getProvider(settings.provider)
  const cfg = settings.providers[provider.id] ?? {}
  const messages = sendableMessages(thread.messages)
  const last = messages.at(-1)
  if (!last || last.role !== 'user') throw new ProviderError('Nothing to send.')
  const usesKey = provider.id === 'opencode' && cfg.zenKey
  if (!(provider.images || usesKey) && last.images?.length) {
    throw new ProviderError(`${provider.name} can't see images. Pick Claude or a vision model for this one.`, { code: 'setup' })
  }
  const system = systemPrompt(settings)
  const model = cfg.model ?? ''

  switch (provider.id) {
    case 'claude-web':
      return sendClaudeWeb({ thread, messages, settings, system, signal, emit })
    case 'claude-code':
    case 'cursor':
      return viaBridge(settings, `${provider.id}/${model || (provider.id === 'cursor' ? 'auto' : 'sonnet')}`, toChatMessages(messages, { system }), signal, emit)
    case 'opencode':
      if (cfg.zenKey) {
        return sendOpenAI({
          label: 'OpenCode Zen',
          baseUrl: provider.zenUrl,
          apiKey: cfg.zenKey,
          model: model || 'big-pickle',
          messages: toChatMessages(messages, { system, images: true }),
          signal,
          emit,
        })
      }
      return viaBridge(settings, `opencode/${model || 'big-pickle'}`, toChatMessages(messages, { system }), signal, emit)
    case 'hermes': {
      const server = await connectedServer(settings)
      return sendOpenAI({
        label: server.kind === 'dashboard' ? server.label : 'Hermes',
        baseUrl: serverChatBase(server, cfg.profile),
        apiKey: server.kind === 'hermes' ? cfg.password : '',
        model: server.kind === 'dashboard' ? model : model || 'hermes-agent',
        headers: server.kind === 'hermes' && cfg.sessionKey ? { 'X-Hermes-Session-Key': cfg.sessionKey } : {},
        messages: toChatMessages(messages, { system, images: true }),
        signal,
        emit,
      })
    }
    case 'custom':
      if (!cfg.baseUrl || !model) throw setup('Add your server URL and pick a model in settings.')
      return sendOpenAI({
        label: 'Your local model',
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model,
        messages: toChatMessages(messages, { system, images: true }),
        signal,
        emit,
      })
    default:
      if (!cfg.apiKey) throw setup(`Add your ${provider.name} key in settings.`)
      if (!model) throw setup(`Pick a ${provider.name} model first.`)
      return sendOpenAI({
        label: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: cfg.apiKey,
        model,
        headers: provider.headers,
        messages: toChatMessages(messages, { system, images: provider.images }),
        signal,
        emit,
      })
  }
}

/* ---------- settings page checks ---------- */

/** A one-line status for the settings page, or throws a ProviderError. */
export async function testProvider(id, settings) {
  const provider = getProvider(id)
  const cfg = settings.providers[id] ?? {}
  if (id === 'claude-web') return testClaudeWeb()
  if (id === 'hermes') {
    if (!cfg.address && !cfg.server) throw setup('Enter the address and press Connect.')
    const server = await connectedServer(settings)
    const ids = await serverModels(server, cfg.password)
    return server.kind === 'dashboard'
      ? `Connected to your dashboard on ${server.label} · ${ids.length} models`
      : `Connected to Hermes on ${server.label}`
  }
  if (id === 'opencode' && cfg.zenKey) {
    await listModels({ baseUrl: provider.zenUrl, apiKey: cfg.zenKey })
    return 'Zen key works · every OpenCode model'
  }
  if (provider.access === 'app' || id === 'opencode') {
    const { ready, note } = await isReady(id, settings, { fresh: true })
    if (!ready) throw setup(note, 'settings:bridge')
    return `Ready · ${note}`
  }
  const { groups, error } = await providerModels(id, settings, { fresh: true })
  if (error) throw error
  return `Works · ${groups.length} model${groups.length === 1 ? '' : 's'}`
}
