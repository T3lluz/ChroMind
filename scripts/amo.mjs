/**
 * addons.mozilla.org API calls for sign-firefox.mjs. Authenticated with
 * AMO_JWT_ISSUER / AMO_JWT_SECRET, an API key from your AMO developer
 * profile: https://addons.mozilla.org/developers/addon/api/key/
 */
import { createHmac, randomUUID } from 'node:crypto'
import { GECKO_ID } from './extension-files.mjs'

const AMO = 'https://addons.mozilla.org/api/v5'

export const addonPath = `/addons/addon/${encodeURIComponent(GECKO_ID)}`

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function hasKeys() {
  return Boolean(process.env.AMO_JWT_ISSUER && process.env.AMO_JWT_SECRET)
}

function token() {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const body =
    part({ alg: 'HS256', typ: 'JWT' }) +
    '.' +
    part({ iss: process.env.AMO_JWT_ISSUER, jti: randomUUID(), iat, exp: iat + 60 })
  return body + '.' + createHmac('sha256', process.env.AMO_JWT_SECRET).update(body).digest('base64url')
}

/**
 * One API call. A GET that finds nothing returns null; other failures
 * throw. When Mozilla throttles (429) it says how long to wait; this waits
 * when that is at most MAXWAIT seconds and throws otherwise.
 */
export async function amo(method, path, body, { maxWait = 120 } = {}) {
  for (;;) {
    const res = await fetch(/^https?:/.test(path) ? path : AMO + path, {
      method,
      headers: {
        Authorization: `JWT ${token()}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) {
      const text = await res.text()
      const wait = Number(res.headers.get('retry-after')) || Number(text.match(/in (\d+) second/)?.[1]) || 60
      if (wait > maxWait) throw new Error(`Mozilla throttles ${method} ${path} for ${wait}s`)
      console.log(`amo: Mozilla asks to wait ${wait}s`)
      await sleep((wait + 2) * 1000)
      continue
    }
    if (res.status === 404 && method === 'GET') return null
    if (!res.ok) throw new Error(`AMO ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 500)}`)
    return res
  }
}
