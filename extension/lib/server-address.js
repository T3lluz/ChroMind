/**
 * Parses what people type for a Hermes server, matching DailyDash / TileSmith:
 *   you@host, you@100.x.y.z, you@host:2222, ssh://you@host, http://127.0.0.1:8642
 *
 * SSH targets need ChroMind Bridge (it opens the tunnel). HTTP URLs talk to the
 * Hermes API server directly.
 */

/**
 * @returns {{ kind: 'ssh', user: string, host: string, port: number, display: string }
 *         | { kind: 'http', baseUrl: string, display: string }
 *         | { kind: 'empty' }
 *         | { kind: 'error', message: string }}
 */
export function parseServerAddress(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { kind: 'empty' }

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      if (!url.hostname) return { kind: 'error', message: 'That URL is missing a host.' }
      return { kind: 'http', baseUrl: text.replace(/\/+$/, ''), display: url.host }
    } catch {
      return { kind: 'error', message: 'That does not look like a URL.' }
    }
  }

  let rest = text
  if (rest.toLowerCase().startsWith('ssh ')) rest = rest.slice(4).trim()
  if (rest.toLowerCase().startsWith('ssh://')) rest = rest.slice(6).replace(/\/+$/, '')

  let port = null
  const portFlag = /(?:^|\s)-p\s*(\d+)\b/.exec(rest)
  if (portFlag) {
    port = Number(portFlag[1])
    rest = (rest.slice(0, portFlag.index) + rest.slice(portFlag.index + portFlag[0].length)).trim()
  }

  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    const user = rest.slice(0, at).trim()
    const hostPart = rest.slice(at + 1).trim()
    if (!user) return { kind: 'error', message: 'Add a user name, like you@hostname.' }
    const ssh = parseHostPort(hostPart, port ?? 22)
    if (ssh.error) return { kind: 'error', message: ssh.error }
    if (!/^[A-Za-z0-9._-]+$/.test(user)) {
      return { kind: 'error', message: 'That user name has characters SSH will not accept.' }
    }
    const display = `${user}@${formatHost(ssh.host)}${ssh.port === 22 ? '' : ':' + ssh.port}`
    return { kind: 'ssh', user, host: ssh.host, port: ssh.port, display }
  }

  // Bare host / host:port → Hermes HTTP API (default port 8642).
  const http = parseHostPort(rest, 8642)
  if (http.error) return { kind: 'error', message: http.error }
  const baseUrl = `http://${formatHost(http.host)}:${http.port}`
  return { kind: 'http', baseUrl, display: `${formatHost(http.host)}:${http.port}` }
}

function parseHostPort(hostPart, defaultPort) {
  let host
  let port = defaultPort
  const text = hostPart.trim()
  if (!text) return { error: 'Enter a hostname or IP address.' }

  if (text.startsWith('[')) {
    const close = text.indexOf(']')
    if (close < 1) return { error: 'Missing ] in IPv6 address.' }
    host = text.slice(1, close)
    const rest = text.slice(close + 1)
    if (rest.startsWith(':')) {
      const p = Number(rest.slice(1))
      if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: 'Port must be between 1 and 65535.' }
      port = p
    }
  } else if ((text.match(/:/g) || []).length === 1) {
    const [h, pRaw] = text.split(':')
    host = h
    const p = Number(pRaw)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: `"${pRaw}" is not a valid port.` }
    port = p
  } else {
    host = text
  }

  host = host.trim().replace(/\.$/, '')
  if (!host || /\s/.test(host)) return { error: 'That does not look like a hostname or IP address.' }
  if (port < 1 || port > 65535) return { error: 'Port must be between 1 and 65535.' }
  return { host, port }
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host
}

/** True when Hermes needs ChroMind Bridge (SSH to the server). */
export function hermesNeedsBridge(address) {
  return parseServerAddress(address).kind === 'ssh'
}
