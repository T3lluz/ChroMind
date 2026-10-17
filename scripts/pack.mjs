/**
 * Release packages, also published next to the docs site:
 *
 *   dist/chromind-chrome.zip            Chromium browsers (Load unpacked / Web Store upload)
 *   dist/chromind-chrome.json           { version, fingerprint, zip }
 *   dist/chromind-firefox-unsigned.xpi  Firefox build before Mozilla signs it
 *   dist/chromind-firefox.json          { version, xpi, unsigned }: xpi stays null
 *                                       until scripts/sign-firefox.mjs has a signed build
 *   dist/chromind-bridge.mjs            the Bridge, as one file to download
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromeManifest, distDir, fingerprint, packBrowser, root } from './extension-files.mjs'

mkdirSync(distDir, { recursive: true })
const { version } = chromeManifest()
const json = (name, data) => writeFileSync(resolve(distDir, name), JSON.stringify(data, null, 2) + '\n')

packBrowser('chrome', resolve(distDir, 'chromind-chrome.zip'))
json('chromind-chrome.json', { version, fingerprint: fingerprint('chrome'), zip: 'chromind-chrome.zip' })
console.log(`OK: dist/chromind-chrome.zip (v${version})`)

packBrowser('firefox', resolve(distDir, 'chromind-firefox-unsigned.xpi'), version)
json('chromind-firefox.json', {
  version,
  fingerprint: fingerprint('firefox'),
  xpi: null,
  unsigned: 'chromind-firefox-unsigned.xpi',
})
console.log(`OK: dist/chromind-firefox-unsigned.xpi (v${version})`)

copyFileSync(resolve(root, 'bridge/chromind-bridge.mjs'), resolve(distDir, 'chromind-bridge.mjs'))
console.log('OK: dist/chromind-bridge.mjs')
