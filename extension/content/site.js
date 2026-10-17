/*
 * Runs on ChroMind's own docs site only (t3lluz.github.io/ChroMind and
 * localhost/ChroMind for npm run dev:site). It tells the install page which
 * version is installed in this browser, so it can say "installed" or
 * "update available". That one attribute is all it exposes: no messages,
 * no listeners, nothing from the extension's storage.
 */
;(() => {
  try {
    const api = globalThis.browser ?? globalThis.chrome
    document.documentElement.dataset.chromindVersion = api.runtime.getManifest().version
  } catch {
    /* extension reloaded or removed while the page was open */
  }
})()
