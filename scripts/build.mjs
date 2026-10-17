/**
 * Unpacked builds for development:
 *
 *   dist/chrome/    Chrome, Edge, Brave, Vivaldi, Arc: Load unpacked
 *                   (extension/ itself works too: it has the Chromium manifest)
 *   dist/firefox/   Firefox, Zen, LibreWolf, Floorp: about:debugging →
 *                   Load Temporary Add-on → dist/firefox/manifest.json,
 *                   or `npm run dev:firefox` / `npm run dev:zen`
 */
import { chromeManifest, writeUnpacked } from './extension-files.mjs'

const { version } = chromeManifest()
for (const browser of ['chrome', 'firefox']) {
  const out = writeUnpacked(browser, version)
  console.log(`OK: ${browser} build v${version} → ${out}`)
}
