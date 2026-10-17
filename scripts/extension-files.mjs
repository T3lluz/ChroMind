/**
 * What goes into the extension, for Chromium and for Firefox. Both ship the
 * same files from extension/; Firefox gets its own manifest.json, written
 * by firefoxManifest() at build time (sidebar instead of side panel, event
 * page instead of service worker, an add-on id and update URL).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

export const root = resolve(import.meta.dirname, '..')
export const extensionDir = resolve(root, 'extension')
export const distDir = resolve(root, 'dist')

/** Where the docs, downloads and Firefox update manifest are published. */
export const SITE = (process.env.CHROMIND_SITE || 'https://t3lluz.github.io/ChroMind').replace(/\/+$/, '')
export const GECKO_ID = 'chromind@t3lluz.com'

/** Every file under extension/, as forward-slash paths, sorted. */
export function extensionFiles() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(extensionDir, path).split(sep).join('/'))
    }
  }
  walk(extensionDir)
  return out.sort()
}

export function chromeManifest() {
  return JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'))
}

/**
 * Firefox runs MV3 background code as an event page, shows a sidebar
 * (sidebar_action) instead of Chromium's side panel, and needs an add-on
 * id. 140 is the ESR that knows data_collection_permissions; update_url is
 * where Firefox looks for new signed builds (scripts/sign-firefox.mjs).
 */
export function firefoxManifest(version) {
  const m = structuredClone(chromeManifest())
  delete m.minimum_chrome_version
  delete m.side_panel
  m.version = version ?? m.version
  m.permissions = m.permissions.filter((p) => p !== 'sidePanel')
  m.background = { scripts: [m.background.service_worker], type: 'module' }
  m.sidebar_action = {
    default_panel: 'sidepanel/sidepanel.html',
    default_title: 'ChroMind',
    default_icon: m.action.default_icon,
    open_at_install: false,
  }
  if (m.commands?._execute_action) {
    m.commands._execute_sidebar_action = m.commands._execute_action
    delete m.commands._execute_action
  }
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '140.0',
      update_url: `${SITE}/chromind-firefox-updates.json`,
      // Page text and questions go to the AI provider the user picks.
      data_collection_permissions: { required: ['websiteContent'] },
    },
  }
  return m
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function fileData(browser, file, version) {
  if (file === 'manifest.json') {
    const manifest = browser === 'firefox' ? firefoxManifest(version) : chromeManifest()
    return Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  }
  return readFileSync(resolve(extensionDir, file))
}

/** Identifies a build by its contents. */
export function fingerprint(browser) {
  return sha256(extensionFiles().map((file) => `${file}\n${sha256(fileData(browser, file))}\n`).join(''))
}

/** Writes an unpacked build to dist/<browser>/ for Load unpacked / about:debugging. */
export function writeUnpacked(browser, version) {
  const out = resolve(distDir, browser)
  rmSync(out, { recursive: true, force: true })
  for (const file of extensionFiles()) {
    const target = resolve(out, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, fileData(browser, file, version))
  }
  return out
}

/** Packs BROWSER's build into OUT (.zip or .xpi, same format). */
export function packBrowser(browser, out, version) {
  const entries = extensionFiles().map((file) => ({ name: file, data: fileData(browser, file, version) }))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, zip(entries))
}

/* ---------- a small zip writer (deflate, no dependencies) ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** ENTRIES: [{ name, data }] → zip Buffer. Fixed timestamp for stable output. */
export function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const DOS_TIME = 0
  const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}
