/**
 * Copies third-party browser code into extension/vendor/. Run after
 * updating the dependency: npm run vendor
 *
 *   @mozilla/readability (Apache-2.0): article extraction for page context
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const vendor = resolve(root, 'extension/vendor')
mkdirSync(vendor, { recursive: true })

const src = resolve(root, 'node_modules/@mozilla/readability/Readability.js')
const { version } = JSON.parse(readFileSync(resolve(root, 'node_modules/@mozilla/readability/package.json'), 'utf8'))
const header = `/* @mozilla/readability ${version}, Apache License 2.0, https://github.com/mozilla/readability */\n`
writeFileSync(resolve(vendor, 'Readability.js'), header + readFileSync(src, 'utf8'))
copyFileSync(resolve(root, 'node_modules/@mozilla/readability/LICENSE.md'), resolve(vendor, 'Readability.LICENSE.md'))
console.log(`OK: extension/vendor/Readability.js (${version})`)
