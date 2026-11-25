import { api } from './browser.js'

/**
 * Header fixes for the extension's own requests. Rules match by initiator
 * (the extension's own origin), so pages and their workers are never touched:
 *
 *   1. claude.ai only accepts its API from claude.ai, so requests there get
 *      Origin/Referer https://claude.ai, as the web app sends.
 *   2. Everything else (Hermes, the Bridge, custom servers) gets no Origin
 *      header at all. With host permissions the browser skips CORS, but
 *      servers with an origin allowlist would still refuse
 *      chrome-extension:// or moz-extension:// origins.
 *
 * Don't match on tabIds: [-1]. Requests from a site's SharedWorker or
 * service worker have no tab either, and stripping their Origin makes CORS
 * servers drop Access-Control-Allow-Origin. That broke 7TV on Twitch.
 *
 * Session rules are cleared when the browser closes, so the background
 * script installs them on every start.
 */
export async function installNetRules() {
  const dnr = api.declarativeNetRequest
  if (!dnr?.updateSessionRules) return
  const claude = {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'origin', operation: 'set', value: 'https://claude.ai' },
      { header: 'referer', operation: 'set', value: 'https://claude.ai/' },
    ],
  }
  const noOrigin = { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] }
  // The background, side panel, settings and full-tab chat all share the
  // extension's origin: its id on Chromium, its UUID on Firefox.
  const self = new URL(api.runtime.getURL('/')).hostname
  const scope = { initiatorDomains: [self] }
  const rules = [
    {
      id: 1,
      priority: 2,
      action: claude,
      condition: { urlFilter: '||claude.ai/api/', resourceTypes: ['xmlhttprequest'], ...scope },
    },
    {
      id: 2,
      priority: 1,
      action: noOrigin,
      condition: { resourceTypes: ['xmlhttprequest'], excludedRequestDomains: ['claude.ai'], ...scope },
    },
  ]
  // 3 and 4 were the old tabIds: [-1] rules. Install each rule on its own so
  // one the browser rejects can't block the rest.
  await dnr.updateSessionRules({ removeRuleIds: [1, 2, 3, 4] }).catch(() => {})
  for (const rule of rules) {
    await dnr.updateSessionRules({ addRules: [rule] }).catch((err) => console.warn('ChroMind: header rule', rule.id, err))
  }
}
