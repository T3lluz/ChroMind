/**
 * Updates. The docs site publishes what the latest build is
 * (chromind-firefox.json / chromind-chrome.json, from scripts/pack.mjs and
 * scripts/sign-firefox.mjs).
 *
 * - Firefox installs signed updates from update_url by itself, about once a
 *   day; "Update now" asks it to check right away (runtime.requestUpdateCheck).
 * - Chromium can't update a loaded-unpacked extension, so settings offer the
 *   new zip and a Reload button for after it's unpacked over the old folder.
 */
import { api, isFirefox, version } from './browser.js'

export const SITE = 'https://t3lluz.github.io/ChroMind'
const KEY = 'updateInfo'
const MAX_AGE = 12 * 3600e3

/** True when version A is newer than version B ("0.3.10" > "0.3.9"). */
export function isNewer(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

function describe(info) {
  const latest = info?.latest ?? null
  return {
    current: version,
    latest,
    checkedAt: info?.checkedAt ?? 0,
    available: !!latest && isNewer(latest, version),
    download: info?.file ? `${SITE}/${info.file}?v=${latest}` : `${SITE}/docs/install/`,
    error: info?.error ?? null,
  }
}

/** What's the latest release? Cached for 12 hours unless FRESH. */
export async function checkForUpdate({ fresh = false } = {}) {
  const { [KEY]: cached } = await api.storage.local.get(KEY).catch(() => ({}))
  if (!fresh && cached?.checkedAt && Date.now() - cached.checkedAt < MAX_AGE) return describe(cached)
  try {
    const res = await fetch(`${SITE}/chromind-${isFirefox ? 'firefox' : 'chrome'}.json`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`The update check failed (${res.status}).`)
    const data = await res.json()
    const info = { latest: data.version, file: isFirefox ? data.xpi : data.zip, checkedAt: Date.now() }
    await api.storage.local.set({ [KEY]: info }).catch(() => {})
    return describe(info)
  } catch (err) {
    return describe({ ...cached, error: err?.message || String(err) })
  }
}

/**
 * Firefox: asks for the update now. Firefox downloads and installs it, and
 * ChroMind restarts on the new version. Resolves to "update_available",
 * "no_update" or "throttled". Elsewhere resolves to "manual".
 */
export async function updateNow() {
  if (!isFirefox || !api.runtime.requestUpdateCheck) return 'manual'
  const result = await api.runtime.requestUpdateCheck()
  return Array.isArray(result) ? result[0] : (result?.status ?? 'no_update')
}
