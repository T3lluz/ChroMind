/**
 * ChroMind Bridge, the optional helper for apps on this computer (Claude
 * Code, Cursor, OpenCode's free models). It pairs itself: when the Bridge
 * answers on 127.0.0.1 ChroMind asks it for its token and remembers it.
 */
import { saveSettings } from '../settings.js'
import { ProviderError } from './errors.js'

const notRunning = (url) =>
  new ProviderError(`ChroMind Bridge isn't running on this computer. Start it once, and it pairs by itself.`, {
    code: 'offline',
    action: 'settings:bridge',
    fix: 'node chromind-bridge.mjs install',
  })

/** The Bridge's token, pairing first when there is none (or it changed). */
export async function bridgeToken(settings, { fresh = false } = {}) {
  const { url, token } = settings.bridge
  if (token && !fresh) return token
  let res
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/v1/pair`, { signal: AbortSignal.timeout(3000) })
  } catch {
    throw notRunning(url)
  }
  if (!res.ok) throw notRunning(url)
  const body = await res.json().catch(() => ({}))
  if (!body.token) throw notRunning(url)
  settings.bridge = { ...settings.bridge, token: body.token }
  await saveSettings({ bridge: { token: body.token } }).catch(() => {})
  return body.token
}

/** GET /v1/status, re-pairing once if the token went stale. */
export async function bridgeStatus(settings, { fresh = false } = {}) {
  const { url } = settings.bridge
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await bridgeToken(settings, { fresh: attempt > 0 })
    let res
    try {
      res = await fetch(`${url.replace(/\/+$/, '')}/v1/status${fresh ? '?fresh=1' : ''}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      })
    } catch {
      throw notRunning(url)
    }
    if (res.status === 401 && attempt === 0) continue
    if (!res.ok) throw new ProviderError(`The Bridge answered ${res.status}.`)
    return res.json()
  }
  throw notRunning(url)
}
