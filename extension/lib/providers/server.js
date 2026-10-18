/**
 * "Your server": type the address (and the password if it has one) and
 * ChroMind finds what's there, over HTTP. A browser extension can't open
 * SSH connections, so this is how DailyDash reaches Hermes too:
 *
 *   dashboard  the t3lluz dashboard's /_api (tailnet-only, no password):
 *              Hermes' model plus the Claude, Cursor and OpenCode logins on
 *              that machine, as `claude:sonnet`, `cursor:auto`, … (DailyDash)
 *   hermes     Hermes Agent's own API server (port 8642); the password is
 *              its API_SERVER_KEY
 *
 * People paste all sorts: "you@100.64.0.5", "ssh you@box -p 22", "box",
 * "https://t3lluz.com", "http://127.0.0.1:8642". The user name and SSH
 * port are dropped; they mean nothing over HTTP.
 */
import { ProviderError } from './errors.js'

const PROBE_MS = 4000

/** { url?: URL, host, port } or { error }. */
export function parseServerAddress(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return { error: 'Enter your server address.' }
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      return { url, host: url.hostname, port: url.port ? Number(url.port) : null }
    } catch {
      return { error: "That doesn't look like an address." }
    }
  }
  if (/^ssh\s/i.test(text)) text = text.slice(4).trim()
  if (/^ssh:\/\//i.test(text)) text = text.slice(6)
  text = text.replace(/(?:^|\s)-p\s*\d+/, '').trim().replace(/\/.*$/, '')
  const at = text.lastIndexOf('@')
  if (at >= 0) text = text.slice(at + 1)
  let host = text
  let port = null
  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    host = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (rest.startsWith(':')) port = Number(rest.slice(1))
  } else if ((text.match(/:/g) ?? []).length === 1) {
    ;[host, port] = text.split(':')
    port = Number(port)
  }
  host = host.trim().replace(/\.$/, '')
  if (!host || /\s/.test(host)) return { error: "That doesn't look like a hostname or IP address." }
  if (port !== null && !(port >= 1 && port <= 65535)) return { error: "That port isn't valid." }
  // An SSH port is no use over HTTP.
  if (port === 22) port = null
  return { host, port }
}

const hostPart = (host) => (host.includes(':') ? `[${host}]` : host)

async function probe(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? PROBE_MS), credentials: 'omit' })
  } catch {
    return null
  }
}

async function json(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** Is ROOT a t3lluz dashboard? Returns its /_api base. */
async function tryDashboard(root) {
  const base = root.replace(/\/+$/, '').replace(/\/_api$/, '') + '/_api'
  const res = await probe(`${base}/health`)
  if (!res?.ok) return null
  const body = await json(res)
  return body?.ok ? base : null
}

/** Is BASE Hermes' API server? Returns { base, models } or throws for a wrong password. */
async function tryHermes(base, password) {
  const health = await probe(`${base}/health`)
  if (!health) return null
  if (!health.ok && health.status !== 401) return null
  const res = await probe(`${base}/v1/models`, { headers: password ? { authorization: `Bearer ${password}` } : {} })
  if (!res) return null
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      password
        ? "Hermes didn't accept that password. Use the API_SERVER_KEY from the server's ~/.hermes/.env (not your SSH password)."
        : "This Hermes needs its password: the API_SERVER_KEY from the server's ~/.hermes/.env.",
      { code: 'auth' },
    )
  }
  if (!res.ok) return null
  const body = await json(res)
  return { base, models: (body?.data ?? []).map((m) => m.id).filter(Boolean) }
}

/**
 * Finds what ADDRESS serves. Resolves { kind, base, label } or throws a
 * ProviderError that says what to do.
 */
export async function detectServer({ address, password }) {
  const target = parseServerAddress(address)
  if (target.error) throw new ProviderError(target.error, { code: 'setup' })
  const { url, host, port } = target
  const label = url ? url.host : host

  const dashboards = url
    ? [url.origin + url.pathname]
    : port
      ? [`http://${hostPart(host)}:${port}`, `https://${hostPart(host)}:${port}`]
      : [`https://${hostPart(host)}`, `http://${hostPart(host)}`]
  const hermeses = url ? [url.origin + url.pathname.replace(/\/v1\/?$/, '').replace(/\/+$/, '')] : [`http://${hostPart(host)}:${port ?? 8642}`]

  // Ask both kinds at once; the dashboard wins when a machine has both.
  const [dashboard, hermes] = await Promise.all([
    Promise.all(dashboards.map(tryDashboard)).then((found) => found.find(Boolean) ?? null),
    Promise.any(hermeses.map(async (b) => (await tryHermes(b, password)) ?? Promise.reject(new Error('no')))).catch((err) => {
      const real = err?.errors?.find?.((e) => e instanceof ProviderError)
      if (real) throw real
      return null
    }),
  ])
  if (dashboard) return { kind: 'dashboard', base: dashboard, label }
  if (hermes) return { kind: 'hermes', base: hermes.base, label }
  throw new ProviderError(
    `Nothing answered at ${label}. Check that the server is on and this computer can reach it (same network or Tailscale).`,
    {
      code: 'offline',
      fix:
        "Hermes' API only listens on the server itself at first. On the server, add API_SERVER_HOST=0.0.0.0 to ~/.hermes/.env and restart `hermes gateway`. Keep the server on Tailscale or your home network.",
    },
  )
}

/** Model ids SERVER offers (detected with detectServer). */
export async function serverModels(server, password) {
  const url = `${server.base}/v1/models`
  const res = await probe(url, {
    headers: server.kind === 'hermes' && password ? { authorization: `Bearer ${password}` } : {},
    timeout: 12000,
  })
  if (!res) throw new ProviderError(`Can't reach ${server.label}.`, { code: 'offline' })
  if (!res.ok) throw new ProviderError(`${server.label} answered ${res.status}.`)
  const body = await json(res)
  return (body?.data ?? []).map((m) => m.id).filter(Boolean)
}

/** Where chats go: the chat endpoint's base for sendOpenAI (which adds /v1). */
export function serverChatBase(server, profile = '') {
  if (server.kind === 'hermes' && profile) return `${server.base}/p/${encodeURIComponent(profile)}/v1`
  return `${server.base}/v1`
}

/** Dashboard ids: "claude:sonnet@xhigh" → provider "claude", model "sonnet@xhigh". */
export function splitServerModel(id) {
  const colon = id.indexOf(':')
  return colon > 0 ? { source: id.slice(0, colon), model: id.slice(colon + 1) } : { source: '', model: id }
}

export const SERVER_SOURCES = { claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode', codex: 'Codex', gemini: 'Gemini' }
