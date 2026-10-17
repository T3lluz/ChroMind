import { api } from './browser.js'

/**
 * Chat threads in storage.local: an index under "threads" (newest first,
 * for the history drawer) and one "thread:<id>" entry per thread.
 */
const INDEX = 'threads'
const MAX_THREADS = 300

export function newThread(fields = {}) {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: 'New chat', createdAt: now, updatedAt: now, messages: [], providerState: {}, ...fields }
}

export async function listThreads() {
  const { [INDEX]: index = [] } = await api.storage.local.get(INDEX)
  return index
}

export async function loadThread(id) {
  const key = `thread:${id}`
  const { [key]: thread } = await api.storage.local.get(key)
  return thread ?? null
}

function preview(thread) {
  const last = [...thread.messages].reverse().find((m) => m.text)
  return (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 140)
}

export async function saveThread(thread) {
  if (!thread.messages.length) return
  thread.updatedAt = Date.now()
  const entry = {
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
    provider: thread.messages.findLast?.((m) => m.provider)?.provider ?? '',
    url: thread.messages.find((m) => m.contexts?.[0]?.url)?.contexts[0].url ?? '',
    preview: preview(thread),
  }
  const index = (await listThreads()).filter((t) => t.id !== thread.id)
  index.unshift(entry)
  const dropped = index.splice(MAX_THREADS)
  await api.storage.local.set({ [INDEX]: index, [`thread:${thread.id}`]: thread })
  if (dropped.length) await api.storage.local.remove(dropped.map((t) => `thread:${t.id}`))
}

export async function deleteThread(id) {
  const index = (await listThreads()).filter((t) => t.id !== id)
  await api.storage.local.set({ [INDEX]: index })
  await api.storage.local.remove(`thread:${id}`)
}

export async function clearThreads() {
  const index = await listThreads()
  await api.storage.local.remove([INDEX, ...index.map((t) => `thread:${t.id}`)])
}

/** Markdown export of one thread. */
export function threadToMarkdown(thread) {
  const lines = [`# ${thread.title}`, '', `_Exported from ChroMind, ${new Date(thread.updatedAt).toLocaleString()}_`, '']
  for (const m of thread.messages) {
    if (m.role === 'user') {
      lines.push(`## You`)
      for (const c of m.contexts ?? []) lines.push(`> ${c.kind}: [${c.title || c.url}](${c.url || ''})`)
      lines.push('', m.text || '', '')
    } else if (m.text) {
      lines.push(`## ${m.providerName || 'ChroMind'}`, '', m.text, '')
    }
  }
  return lines.join('\n')
}
