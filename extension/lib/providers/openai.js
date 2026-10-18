/**
 * OpenAI-compatible chat completions with streaming. Used for Hermes Agent
 * (its API server), the ChroMind Bridge (Claude Code and Cursor) and any
 * other compatible server (Ollama, LM Studio, OpenRouter, vLLM…).
 *
 * Besides the standard `choices[].delta` chunks it understands
 *   - `delta.reasoning_content` / `delta.reasoning` (thinking),
 *   - named SSE events with "tool" in the name: Hermes'
 *     `hermes.tool.progress` and the Bridge's `chromind.tool`.
 */
import { parseJSON, readSSE } from '../sse.js'
import { ProviderError } from './errors.js'

/** BASE + '/v1' + PATH, unless BASE already ends in a version segment. */
export function endpoint(base, path, profile = '') {
  let root = String(base || '').trim().replace(/\/+$/, '')
  if (profile) root += `/p/${encodeURIComponent(profile)}`
  // Already versioned: /v1, Gemini's /v1beta/openai.
  if (!/\/v\d+(beta)?(\/openai)?$/.test(root)) root += '/v1'
  return root + path
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function failure(res, label, url) {
  const text = await res.text().catch(() => '')
  const json = parseJSON(text)
  const detail = json?.error?.message || json?.error || json?.detail || json?.message || text.slice(0, 200)
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`${label} rejected the key. Check it in ChroMind settings.`, {
      code: 'setup',
      action: 'settings',
    })
  }
  if (res.status === 404) {
    return new ProviderError(`${label} has no chat endpoint at ${url}. Check the server URL.`, {
      code: 'setup',
      action: 'settings',
    })
  }
  if (res.status === 429) return new ProviderError(`${label} is busy or rate limited: ${detail}`, { code: 'rate' })
  return new ProviderError(`${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)} (${res.status})`)
}

export async function sendOpenAI({ label, baseUrl, apiKey, profile, model, messages, headers = {}, signal, emit }) {
  if (!baseUrl) {
    throw new ProviderError(`Set the ${label} server URL in ChroMind settings first.`, {
      code: 'setup',
      action: 'settings',
    })
  }
  const url = endpoint(baseUrl, '/chat/completions', profile)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...authHeaders(apiKey),
        ...headers,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new ProviderError(`Can't reach ${label} at ${hostOf(url)}. Is it running?`, { code: 'offline' })
  }
  if (!res.ok) throw await failure(res, label, url)

  const type = res.headers.get('content-type') || ''
  if (!type.includes('event-stream')) {
    const json = parseJSON(await res.text())
    const text = json?.choices?.[0]?.message?.content
    if (!text) throw new ProviderError(`${label} sent an empty answer.`)
    emit({ type: 'text', text })
    return {}
  }

  for await (const { event, data } of readSSE(res, signal)) {
    if (data === '[DONE]') break
    const json = parseJSON(data)
    if (!json) continue
    if (event !== 'message') {
      if (/tool/i.test(event)) {
        emit({
          type: 'tool',
          name: json.tool ?? json.name ?? json.tool_name ?? json.label ?? 'tool',
          detail: json.detail ?? json.preview ?? json.message ?? '',
          status: json.status ?? json.phase ?? '',
        })
      } else if (event === 'error') {
        throw new ProviderError(json.message ?? json.error?.message ?? `${label} failed.`)
      }
      continue
    }
    if (json.error) throw new ProviderError(json.error.message ?? String(json.error))
    const delta = json.choices?.[0]?.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning) emit({ type: 'reasoning', text: reasoning })
    if (delta.content) emit({ type: 'text', text: delta.content })
    if (json.model && !json.choices?.length) emit({ type: 'meta', model: json.model })
  }
  return {}
}

export async function listModels({ baseUrl, apiKey, profile, headers = {} }) {
  let res
  try {
    res = await fetch(endpoint(baseUrl, '/models', profile), {
      headers: { ...authHeaders(apiKey), ...headers },
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new ProviderError(`Can't reach ${hostOf(baseUrl)}.`, { code: 'offline' })
  }
  if (!res.ok) throw await failure(res, hostOf(baseUrl), baseUrl)
  const json = await res.json()
  return (json.data ?? json.models ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
}
