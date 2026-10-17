/**
 * Bumps the version everywhere it lives: npm run release -- patch|minor|major|x.y.z
 * (extension/manifest.json, package.json, the Bridge). Commit, push, and the
 * Pages workflow signs the new Firefox build and publishes both packages.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const arg = process.argv[2] ?? 'patch'
const manifestPath = resolve(root, 'extension/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const [major, minor, patch] = manifest.version.split('.').map(Number)
const next =
  arg === 'major'
    ? `${major + 1}.0.0`
    : arg === 'minor'
      ? `${major}.${minor + 1}.0`
      : arg === 'patch'
        ? `${major}.${minor}.${patch + 1}`
        : arg

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Not a version: ${next}`)
  process.exit(1)
}

manifest.version = next
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

const pkgPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const bridgePath = resolve(root, 'bridge/chromind-bridge.mjs')
writeFileSync(bridgePath, readFileSync(bridgePath, 'utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${next}'`))

console.log(`ChroMind is now v${next}. Add a changelog entry in site/pages/changelog.html.`)
