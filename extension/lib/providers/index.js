/**
 * The providers ChroMind can talk to, and one entry point, runChat(), that
 * streams an answer for a thread from whichever one is selected.
 *
 * Adding a provider: describe it in PROVIDERS, give it a branch in
 * runChat() and testProvider(), and add its defaults to lib/settings.js.
 */
import { systemPrompt, toChatMessages } from '../prompts.js'
import { parseServerAddress } from '../server-address.js'
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
    detail: 'Your server — user@ip, like TileSmith',
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
    return sendHermes({ cfg, settings, messages, system, signal, emit })
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

/** Hermes over SSH (via Bridge) or a direct HTTP API URL. */
async function sendHermes({ cfg, settings, messages, system, signal, emit }) {
  const target = parseServerAddress(cfg.address)
  if (target.kind === 'empty') {
    throw new ProviderError('Set the Hermes server address in settings (you@your-server or http://127.0.0.1:8642).', {
      code: 'setup',
      action: 'settings',
    })
  }
  if (target.kind === 'error') throw new ProviderError(target.message, { code: 'setup', action: 'settings' })

  const sessionHeaders = cfg.sessionKey ? { 'X-Hermes-Session-Key': cfg.sessionKey } : {}
  const chatMessages = toChatMessages(messages, { system, images: true })
  const model = cfg.model || 'hermes-agent'

  if (target.kind === 'http') {
    if (!cfg.password) {
      throw new ProviderError('Enter the Hermes API key (API_SERVER_KEY) in the Password field.', {
        code: 'setup',
        action: 'settings',
      })
    }
    return sendOpenAI({
      label: 'Hermes',
      baseUrl: target.baseUrl,
      apiKey: cfg.password,
      profile: cfg.profile,
      model,
      headers: sessionHeaders,
      messages: chatMessages,
      signal,
      emit,
    })
  }

  const { url, token } = settings.bridge
  if (!token) {
    throw new ProviderError('SSH Hermes needs ChroMind Bridge. Start it and paste its token in settings.', {
      code: 'setup',
      action: 'settings:bridge',
    })
  }
  if (!cfg.password) {
    throw new ProviderError('Enter the SSH password for the server.', { code: 'setup', action: 'settings' })
  }
  return sendOpenAI({
    label: 'Hermes',
    baseUrl: url,
    apiKey: token,
    model: `hermes/${model}`,
    headers: {
      ...sessionHeaders,
      'X-ChroMind-Server': cfg.address.trim(),
      'X-ChroMind-Server-Password': cfg.password,
      'X-ChroMind-Api-Port': String(cfg.apiPort || 8642),
      ...(cfg.profile ? { 'X-ChroMind-Hermes-Profile': cfg.profile } : {}),
    },
    messages: chatMessages,
    signal,
    emit,
  })
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
  if (id === 'hermes') return testHermes(cfg, settings)
  const models = await listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, profile: cfg.profile }).catch((err) => {
    if (err instanceof ProviderError) throw err
    throw new ProviderError(`Can't reach ${cfg.baseUrl}. Is the server running?`, { code: 'offline' })
  })
  return `Connected · ${models.length} model${models.length === 1 ? '' : 's'}${models.length ? ': ' + models.slice(0, 4).join(', ') : ''}`
}

async function testHermes(cfg, settings) {
  const target = parseServerAddress(cfg.address)
  if (target.kind === 'empty') {
    throw new ProviderError('Enter you@your-server (SSH) or http://127.0.0.1:8642.', { code: 'setup' })
  }
  if (target.kind === 'error') throw new ProviderError(target.message, { code: 'setup' })

  if (target.kind === 'http') {
    const models = await listModels({
      baseUrl: target.baseUrl,
      apiKey: cfg.password,
      profile: cfg.profile,
    }).catch((err) => {
      if (err instanceof ProviderError) throw err
      throw new ProviderError(`Can't reach ${target.baseUrl}. Is Hermes running?`, { code: 'offline' })
    })
    return `Connected · ${models.length} model${models.length === 1 ? '' : 's'}${models.length ? ': ' + models.slice(0, 4).join(', ') : ''}`
  }

  const { url, token } = settings.bridge
  if (!token) {
    throw new ProviderError('Start ChroMind Bridge and paste its token first.', {
      code: 'setup',
      action: 'settings:bridge',
    })
  }
  if (!cfg.password) throw new ProviderError('Enter the SSH password for the server.', { code: 'setup' })

  let res
  try {
    res = await fetch(endpoint(url, '/server/test'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        address: cfg.address.trim(),
        password: cfg.password,
        apiPort: Number(cfg.apiPort) || 8642,
      }),
    })
  } catch {
    throw new ProviderError(`ChroMind Bridge is not running at ${url}.`, {
      code: 'offline',
      action: 'settings:bridge',
    })
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ProviderError(json?.error?.message || `Bridge answered ${res.status}.`, {
      code: res.status === 401 ? 'setup' : 'offline',
    })
  }
  const models = json.models ?? []
  return `Connected to ${json.display || target.display} · Hermes API${models.length ? ': ' + models.slice(0, 4).join(', ') : ''}`
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
  if (id === 'hermes') {
    const target = parseServerAddress(cfg.address)
    if (target.kind === 'http') {
      return listModels({ baseUrl: target.baseUrl, apiKey: cfg.password, profile: cfg.profile })
    }
    if (target.kind === 'ssh') {
      await testHermes(cfg, settings)
      const status = await bridgeStatus(settings)
      return status.server?.models ?? status.providers?.hermes?.models ?? ['hermes-agent']
    }
    throw new ProviderError('Enter a Hermes server address first.', { code: 'setup' })
  }
  return listModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, profile: cfg.profile })
}
