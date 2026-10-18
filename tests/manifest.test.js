import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { chromeManifest, extensionDir, extensionFiles, firefoxManifest, GECKO_ID, zip } from '../scripts/extension-files.mjs'

const chrome = chromeManifest()
const firefox = firefoxManifest()
const exists = (path) => existsSync(resolve(extensionDir, path))

test('every file the manifests point at exists', () => {
  const paths = [
    chrome.background.service_worker,
    chrome.side_panel.default_path,
    chrome.options_ui.page,
    ...Object.values(chrome.icons),
    ...Object.values(chrome.action.default_icon),
    ...chrome.content_scripts.flatMap((c) => c.js),
    firefox.sidebar_action.default_panel,
  ]
  for (const path of paths) assert.ok(exists(path), `missing ${path}`)
})

test('pages load their scripts and styles from files that exist', () => {
  for (const page of ['sidepanel/sidepanel.html', 'options/options.html']) {
    const html = readFileSync(resolve(extensionDir, page), 'utf8')
    for (const [, ref] of html.matchAll(/(?:src|href)="(\.\.\/[^"]+|[\w-]+\.(?:js|css))"/g)) {
      assert.ok(exists(resolve(extensionDir, page, '..', ref).slice(extensionDir.length + 1)), `${page} → ${ref}`)
    }
  }
})

test('Firefox manifest: sidebar, event page, gecko id, no Chromium-only keys', () => {
  assert.equal(firefox.side_panel, undefined)
  assert.equal(firefox.minimum_chrome_version, undefined)
  assert.ok(!firefox.permissions.includes('sidePanel'))
  assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' })
  assert.equal(firefox.browser_specific_settings.gecko.id, GECKO_ID)
  assert.match(firefox.browser_specific_settings.gecko.update_url, /^https:\/\/.+\/chromind-firefox-updates\.json$/)
  assert.ok(firefox.commands._execute_sidebar_action)
  assert.equal(firefox.commands._execute_action, undefined)
  assert.equal(firefox.version, chrome.version)
})

test('Chromium manifest keeps the side panel and service worker', () => {
  assert.equal(chrome.manifest_version, 3)
  assert.ok(chrome.permissions.includes('sidePanel'))
  assert.equal(chrome.background.type, 'module')
  assert.ok(chrome.commands._execute_action)
})

test('the docs-site content script runs on the docs site only, in both browsers', () => {
  for (const manifest of [chrome, firefox]) {
    const site = manifest.content_scripts.find((c) => c.js.includes('content/site.js'))
    assert.ok(site, 'content/site.js is registered')
    assert.deepEqual(site.js, ['content/site.js'])
    // No ports: Firefox doesn't support them in match patterns.
    assert.deepEqual(site.matches, ['https://t3lluz.github.io/ChroMind/*', 'http://localhost/ChroMind/*'])
    assert.equal(site.run_at, 'document_start')
  }
  const source = readFileSync(resolve(extensionDir, 'content/site.js'), 'utf8')
  assert.doesNotMatch(source, /postMessage|addEventListener|onMessage|sendMessage|connect\(|\.storage\./)
})

test('package.json and manifest agree on the version', () => {
  const pkg = JSON.parse(readFileSync(resolve(extensionDir, '../package.json'), 'utf8'))
  assert.equal(pkg.version, chrome.version)
})

test('zip writer round-trips', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
    { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) },
  ]
  const buf = zip(entries)
  const eocd = buf.length - 22
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50)
  assert.equal(buf.readUInt16LE(eocd + 10), 2)
  let offset = 0
  for (const entry of entries) {
    assert.equal(buf.readUInt32LE(offset), 0x04034b50)
    const method = buf.readUInt16LE(offset + 8)
    const size = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    assert.equal(buf.toString('utf8', offset + 30, offset + 30 + nameLen), entry.name)
    const body = buf.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size)
    assert.deepEqual(method === 8 ? inflateRawSync(body) : body, entry.data)
    offset += 30 + nameLen + size
  }
})

test('extension files include the vendored Readability and no stray files', () => {
  const files = extensionFiles()
  assert.ok(files.includes('vendor/Readability.js'))
  assert.ok(files.every((f) => !f.includes('node_modules')))
})
