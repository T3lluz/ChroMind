import { api } from './browser.js'

/**
 * Header fixes for the extension's own requests (tabId -1 = not from a
 * tab, so pages are never touched):
 *
 *   1. claude.ai only accepts its API from claude.ai, so requests there get
 *      Origin/Referer https://claude.ai, as the web app sends.
 *   2. Everything else (Hermes, the Bridge, custom servers) gets no Origin
 *      header at all. With host permissions the browser skips CORS, but
 *      servers with an origin allowlist would still refuse
 *      chrome-extension:// or moz-extension:// origins.
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
  // Requests from the background and side panel have no tab (-1). Settings
  // and the full-tab chat are extension pages *in* a tab, so also match by
  // initiator: the extension's own origin host (its id, or Firefox's UUID).
  const self = new URL(api.runtime.getURL('/')).hostname
  const scopes = [{ tabIds: [-1] }, { initiatorDomains: [self] }]
  const rules = scopes.flatMap((scope, i) => [
    {
      id: 1 + i * 2,
      priority: 2,
      action: claude,
      condition: { urlFilter: '||claude.ai/api/', resourceTypes: ['xmlhttprequest'], ...scope },
    },
    {
      id: 2 + i * 2,
      priority: 1,
      action: noOrigin,
      condition: { resourceTypes: ['xmlhttprequest'], excludedRequestDomains: ['claude.ai'], ...scope },
    },
  ])
  // Install each rule on its own so one the browser rejects can't block the rest.
  await dnr.updateSessionRules({ removeRuleIds: [1, 2, 3, 4] }).catch(() => {})
  for (const rule of rules) {
    await dnr.updateSessionRules({ addRules: [rule] }).catch((err) => console.warn('ChroMind: header rule', rule.id, err))
  }
}
