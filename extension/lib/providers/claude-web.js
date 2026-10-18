/**
 * Claude through the user's own claude.ai login. Requests go from the
 * extension straight to claude.ai with the browser's claude.ai cookies, the
 * way the claude.ai web app does; no API key and nothing in between.
 *
 * Each ChroMind thread maps to one claude.ai conversation, so follow-ups
 * stay in the same chat and show up in the user's claude.ai history (or
 * not, with "keep history" off). The thread keeps { org, conversationId,
 * parent, parentBefore, synced } in providerState['claude-web'].
 *
 * claude.ai checks Origin; lib/net-rules.js sets it to https://claude.ai
 * for the extension's own requests.
 */
import { contextBlock, transcript } from '../prompts.js'
import { parseJSON, readSSE } from '../sse.js'
import { ProviderError } from './errors.js'

export const ORIGIN = 'https://claude.ai'
const API = `${ORIGIN}/api`
const ROOT = '00000000-0000-4000-8000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function call(path, init = {}) {
  return fetch(API + path, {
    credentials: 'include',
    ...init,
    headers: {
      'content-type': 'application/json',
      'anthropic-client-platform': 'web_claude_ai',
      ...(init.headers ?? {}),
    },
  })
}

async function failure(res, what) {
  const body = await res.text().catch(() => '')
  const json = parseJSON(body)
  const detail = json?.error?.message || json?.detail || ''
  if (res.status === 401 || res.status === 403) {
    if (/just a moment|cf-chl|cloudflare/i.test(body)) {
      return new ProviderError('claude.ai wants a quick browser check. Open claude.ai in a tab once, then try again.', {
        code: 'auth',
        link: ORIGIN,
        linkLabel: 'Open claude.ai',
      })
    }
    return new ProviderError('Sign in to claude.ai in this browser, then try again.', {
      code: 'auth',
      link: `${ORIGIN}/login`,
      linkLabel: 'Sign in to claude.ai',
    })
  }
  if (res.status === 429) {
    return new ProviderError(detail || 'You have hit your claude.ai usage limit. Try again later or switch provider.', {
      code: 'rate',
    })
  }
  return new ProviderError(`claude.ai ${what}: ${detail || res.statusText || 'error'} (${res.status})`)
}

function planOf(capabilities = []) {
  if (capabilities.includes('claude_max')) return 'Max'
  if (capabilities.includes('claude_pro')) return 'Pro'
  if (capabilities.includes('raven')) return 'Team'
  return 'Free'
}

let cachedOrg = null

/** The claude.ai organization to chat in: the first one that can chat, paid first. */
export async function getOrganization({ fresh = false } = {}) {
  if (cachedOrg && !fresh) return cachedOrg
  let res
  try {
    res = await call('/organizations')
  } catch {
    throw new ProviderError("Can't reach claude.ai. Check your connection.", { code: 'offline' })
  }
  if (!res.ok) throw await failure(res, 'account check failed')
  const orgs = (await res.json()) ?? []
  const chat = orgs.filter((o) => (o.capabilities ?? []).includes('chat'))
  const org = chat.find((o) => planOf(o.capabilities) !== 'Free') ?? chat[0] ?? orgs[0]
  if (!org) throw new ProviderError('This claude.ai login has no organization that can chat.', { code: 'auth' })
  cachedOrg = { uuid: org.uuid, name: org.name, plan: planOf(org.capabilities) }
  return cachedOrg
}

async function createConversation(org, title, temporary, signal) {
  const uuid = crypto.randomUUID()
  const res = await call(`/organizations/${org}/chat_conversations`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      uuid,
      name: title ? `ChroMind · ${title}`.slice(0, 120) : 'ChroMind',
      ...(temporary ? { is_temporary: true } : {}),
    }),
  })
  if (!res.ok) throw await failure(res, 'could not start a chat')
  const json = parseJSON(await res.text())
  return json?.uuid ?? uuid
}

export async function deleteConversation(state) {
  if (!state?.org || !state?.conversationId) return
  await call(`/organizations/${state.org}/chat_conversations/${state.conversationId}`, { method: 'DELETE' }).catch(
    () => {},
  )
}

async function leafUuid(org, conversationId, signal) {
  const res = await call(
    `/organizations/${org}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages`,
    { signal },
  ).catch(() => null)
  if (!res?.ok) return null
  const json = parseJSON(await res.text())
  return json?.current_leaf_message_uuid ?? json?.chat_messages?.at(-1)?.uuid ?? null
}

async function uploadImage(org, image, signal) {
  const blob = await (await fetch(image.dataUrl)).blob()
  const form = new FormData()
  form.append('file', blob, image.name || 'image.png')
  const res = await fetch(`${API}/${org}/upload`, { method: 'POST', body: form, credentials: 'include', signal })
  if (!res.ok) throw await failure(res, 'image upload failed')
  const json = parseJSON(await res.text())
  const id = json?.file_uuid ?? json?.uuid
  if (!id) throw new ProviderError('claude.ai did not accept the image.')
  return id
}

/**
 * Sends the last user message of MESSAGES. Returns the new providerState
 * for this thread.
 */
export async function sendClaudeWeb({ thread, messages, settings, system, signal, emit }, retried = false) {
  const cfg = settings.providers['claude-web'] ?? {}
  const org = await getOrganization()
  const last = messages.at(-1)
  const earlier = messages.slice(0, -1)

  let state = thread.providerState?.['claude-web'] ?? null
  if (state && state.org !== org.uuid) state = null
  let parent = null
  if (state?.synced === earlier.length) parent = state.parent
  else if (state?.synced === earlier.length + 2 && state.parentBefore) parent = state.parentBefore // regenerate
  if (!parent) {
    const conversationId = await createConversation(org.uuid, thread.title, cfg.keepHistory === false, signal)
    state = { org: org.uuid, conversationId, parent: ROOT, synced: 0 }
    parent = ROOT
  }

  const context = []
  if (parent === ROOT) {
    context.push(`<instructions>\n${system}\n</instructions>`)
    if (earlier.length) context.push(`<earlier_conversation>\n${transcript(earlier)}\n</earlier_conversation>`)
  }
  for (const ctx of last.contexts ?? []) if (ctx.text) context.push(contextBlock(ctx))
  const attachments = []
  if (context.length) {
    const content = context.join('\n\n')
    attachments.push({
      file_name: 'chromind-context.txt',
      file_type: 'text/plain',
      file_size: new Blob([content]).size,
      extracted_content: content,
    })
  }
  const files = []
  for (const image of last.images ?? []) files.push(await uploadImage(org.uuid, image, signal))

  const body = {
    prompt: last.text?.trim() || 'Please help with the attached context.',
    parent_message_uuid: parent,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: globalThis.navigator?.language || 'en-US',
    rendering_mode: 'messages',
    attachments,
    files,
  }
  if (cfg.model) body.model = cfg.model

  const res = await call(`/organizations/${org.uuid}/chat_conversations/${state.conversationId}/completion`, {
    method: 'POST',
    signal,
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  if (res.status === 404 && parent !== ROOT && !retried) {
    // The chat was deleted on claude.ai: start a new one with the history.
    return sendClaudeWeb({ thread: { ...thread, providerState: {} }, messages, settings, system, signal, emit }, true)
  }
  if (!res.ok) throw await failure(res, 'request failed')

  emit({ type: 'meta', link: `${ORIGIN}/chat/${state.conversationId}`, linkLabel: 'Open in claude.ai' })

  let assistantUuid = null
  for await (const { event, data } of readSSE(res, signal)) {
    const json = parseJSON(data)
    if (!json) continue
    switch (json.type || event) {
      case 'completion':
        if (json.completion) emit({ type: 'text', text: json.completion })
        break
      case 'message_start':
        assistantUuid = json.message?.uuid ?? assistantUuid
        if (json.message?.model) emit({ type: 'meta', model: json.message.model })
        break
      case 'content_block_start':
        if (json.content_block?.type === 'tool_use') emit({ type: 'tool', name: json.content_block.name })
        break
      case 'content_block_delta': {
        const d = json.delta ?? {}
        if (d.type === 'text_delta' && d.text) emit({ type: 'text', text: d.text })
        else if (d.type === 'thinking_delta' && d.thinking) emit({ type: 'reasoning', text: d.thinking })
        break
      }
      case 'message_limit':
        if (json.message_limit?.type === 'exceeded_limit') {
          throw new ProviderError('You have reached your claude.ai usage limit for now.', { code: 'rate' })
        }
        break
      case 'error':
        throw new ProviderError(json.error?.message || 'claude.ai returned an error.')
    }
  }

  if (!UUID.test(assistantUuid ?? '')) assistantUuid = await leafUuid(org.uuid, state.conversationId, signal)
  return {
    providerState: {
      org: org.uuid,
      conversationId: state.conversationId,
      parentBefore: parent,
      parent: assistantUuid ?? parent,
      synced: messages.length + 1,
    },
  }
}

export async function testClaudeWeb() {
  const org = await getOrganization({ fresh: true })
  return `Signed in · ${org.name} (${org.plan})`
}
