/**
 * The providers ChroMind can talk to, and one entry point, runChat(), that
 * streams an answer for a thread from whichever one is selected.
 *
 * Adding a provider: describe it in PROVIDERS, give it a branch in
 * runChat() and testProvider(), and add its defaults to lib/settings.js.
 */
import { systemPrompt, toChatMessages } from '../prompts.js'
import { CLAUDE_WEB_MODELS, sendClaudeWeb, testClaudeWeb } from './claude-web.js'
import { ProviderError } from './errors.js'
import { endpoint, listModels, sendOpenAI } from './openai.js'

export { ProviderError }

export const PROVIDERS = [
  {
    id: 'claude-web',
    name: 'Claude',
    detail: 'Your claude.ai login',
    images: true,
    models: CLAUDE_WEB_MODELS,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    detail: 'Your Claude login, through ChroMind Bridge',
    bridge: true,
    images: false,
    models: [
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
      { id: 'haiku', label: 'Haiku' },
      { id: 'fable', label: 'Fable' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detail: 'Your Cursor login, through ChroMind Bridge',
    bridge: true,
    images: false,
    freeModel: true,
    models: [{ id: 'auto', label: 'Auto' }],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    detail: 'Your Hermes Agent server',
    images: true,
    freeModel: true,
    models: [{ id: 'hermes-agent', label: 'hermes-agent' }],
  },
  {
    id: 'custom',
    name: 'OpenAI-compatible',
    detail: 'Ollama, LM Studio, OpenRouter and friends',
    images: true,
    freeModel: true,
    models: [],
  },
]

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/** "Claude · Sonnet 5.5", for pills and message footers. */
export function providerLabel(settings, id = settings.provider) {
  const provider = getProvider(id)
  const cfg = settings.providers[provider.id] ?? {}
  const name = provider.id === 'custom' && cfg.name ? cfg.name : provider.name
  const model = modelLabel(provider, cfg.model)
  return { name, model, full: model ? `${name} · ${model}` : name }
}

export function modelLabel(provider, modelId) {
  if (!modelId) return ''
  return provider.models.find((m) => m.id === modelId)?.label ?? modelId
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
  if (!provider.images && last.images?.length) {
    throw new ProviderError(`${provider.name} can't see images. Switch to Claude, Hermes or a vision model for this one.`, {
      code: 'setup',
    })
  }
  const system = systemPrompt(settings)

  if (provider.id === 'claude-web') {
    return sendClaudeWeb({ thread, messages, settings, system, signal, emit })
  }

  if (provider.bridge) {
    const { url, token } = settings.bridge
    if (!token) {
      throw new ProviderError('Connect ChroMind Bridge first: run it, then paste its token in settings.', {
        code: 'setup',
        action: 'settings:bridge',
      })
    }
    return sendOpenAI({
      label: 'ChroMind Bridge',
      baseUrl: url,
      apiKey: token,
      model: `${provider.id}/${cfg.model || provider.models[0].id}`,
      messages: toChatMessages(messages, { system }),
      signal,
      emit,
    })
  }

  if (provider.id === 'hermes') {
    return sendOpenAI({
      label: 'Hermes',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      profile: cfg.profile,
      model: cfg.model || 'hermes-agent',
      headers: cfg.sessionKey ? { 'X-Hermes-Session-Key': cfg.sessionKey } : {},
      messages: toChatMessages(messages, { system, images: true }),
      signal,
      emit,
    })
  }

  if (!cfg.model) {
    throw new ProviderError('Pick a model for your OpenAI-compatible server in settings.', {
      code: 'setup',
      action: 'settings',
    })
  }
  return sendOpenAI({
    label: cfg.name || 'Server',
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages: toChatMessages(messages, { system, images: true }),
    signal,
    emit,
  })
}

/** Messages a provider should see: no failed turns, up to the last user message. */
export function sendableMessages(messages) {
  const out = messages.filter((m) => !m.error && (m.role === 'user' || m.text))
  while (out.length && out.at(-1).role !== 'user') out.pop()
  return out
}

/** A one-line status for the settings page, or throws a ProviderError. */
export async function testProvider(id, settings) {
  const provider = getProvider(id)
  const cfg = settings.providers[id] ?? {}
  if (id === 'claude-web') return testClaudeWeb()
  if (provider.bridge) {
    const status = await bridgeStatus(settings)
    const cli = status.providers?.[id]
    if (!cli?.installed) throw new ProviderError(`Bridge is running, but it can't find the ${provider.name} CLI.`)
    if (cli.loggedIn === false) throw new ProviderError(`${provider.name} CLI is not signed in. ${cli.hint ?? ''}`.trim())
    return `Ready · ${provider.name} CLI ${cli.version ?? ''}`.trim()
  }
  const models = await listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, profile: cfg.profile }).catch((err) => {
    if (err instanceof ProviderError) throw err
    throw new ProviderError(`Can't reach ${cfg.baseUrl}. Is the server running?`, { code: 'offline' })
  })
  return `Connected · ${models.length} model${models.length === 1 ? '' : 's'}${models.length ? ': ' + models.slice(0, 4).join(', ') : ''}`
}

export async function bridgeStatus(settings) {
  const { url, token } = settings.bridge
  let res
  try {
    res = await fetch(endpoint(url, '/status'), { headers: token ? { authorization: `Bearer ${token}` } : {} })
  } catch {
    throw new ProviderError(`ChroMind Bridge is not running at ${url}. Start it, then try again.`, {
      code: 'offline',
      action: 'settings:bridge',
    })
  }
  if (res.status === 401) throw new ProviderError('Bridge is running but the token does not match. Paste it again.')
  if (!res.ok) throw new ProviderError(`Bridge answered ${res.status}.`)
  return res.json()
}

export async function fetchModels(id, settings) {
  const cfg = settings.providers[id] ?? {}
  if (getProvider(id).bridge) {
    const status = await bridgeStatus(settings)
    return status.providers?.[id]?.models ?? []
  }
  return listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, profile: cfg.profile })
}
