/**
 * Gets the Firefox build signed by addons.mozilla.org (as an *unlisted*
 * add-on: Mozilla signs it, but it is only offered from the docs site, not
 * on the add-ons store). Release Firefox installs nothing unsigned, so this
 * is what makes the one-click "Add to Firefox" work.
 *
 *   dist/chromind-firefox.xpi            the signed build
 *   dist/chromind-firefox.json           what the install page offers
 *   dist/chromind-firefox-updates.json   Firefox's own update check (update_url)
 *
 * AMO itself is the state: each manifest version is uploaded once. If that
 * version is already on AMO this downloads its signed file, so CI can run
 * this on every deploy. Ship a Firefox update by bumping the version
 * (npm run release -- patch).
 *
 * Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (GitHub secrets in CI). Without
 * them it leaves the unsigned build in place and exits 0.
 * Run after scripts/pack.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { addonPath, amo, hasKeys, sleep } from './amo.mjs'
import { chromeManifest, distDir, GECKO_ID, sha256, SITE } from './extension-files.mjs'

const WAIT_MS = 20 * 60 * 1000
const { version } = chromeManifest()
const unsigned = resolve(distDir, 'chromind-firefox-unsigned.xpi')
const signed = resolve(distDir, 'chromind-firefox.xpi')

async function until(what, check) {
  const end = Date.now() + WAIT_MS
  for (;;) {
    const result = await check()
    if (result) return result
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`)
    await sleep(10_000)
  }
}

async function findVersion() {
  const res = await amo('GET', `${addonPath}/versions/?filter=all_with_unlisted&page_size=50`)
  if (!res) return null // the add-on does not exist yet
  return (await res.json()).results.find((v) => v.version === version) ?? null
}

async function submit() {
  const form = new FormData()
  form.append('upload', new Blob([readFileSync(unsigned)]), `chromind-firefox-${version}.xpi`)
  form.append('channel', 'unlisted')
  const { uuid } = await (await amo('POST', '/addons/upload/', form)).json()
  const upload = await until('validation', async () => {
    const u = await (await amo('GET', `/addons/upload/${uuid}/`)).json()
    return u.processed ? u : null
  })
  if (!upload.valid) {
    const errors = (upload.validation?.messages ?? [])
      .filter((m) => m.type === 'error')
      .map((m) => `${m.message} ${m.file ?? ''}`.trim())
    throw new Error(`validation failed: ${errors.join('; ') || 'see AMO'}`)
  }
  // Creates the add-on under its id the first time, adds a version after.
  await amo('PUT', `${addonPath}/`, { version: { upload: uuid } })
}

function publish() {
  const xpi = readFileSync(signed)
  const infoPath = resolve(distDir, 'chromind-firefox.json')
  const info = JSON.parse(readFileSync(infoPath, 'utf8'))
  writeFileSync(infoPath, JSON.stringify({ ...info, version, xpi: 'chromind-firefox.xpi' }, null, 2) + '\n')
  writeFileSync(
    resolve(distDir, 'chromind-firefox-updates.json'),
    JSON.stringify(
      {
        addons: {
          [GECKO_ID]: {
            updates: [
              {
                version,
                update_link: `${SITE}/chromind-firefox.xpi?v=${version}`,
                update_hash: `sha256:${sha256(xpi)}`,
              },
            ],
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`OK: dist/chromind-firefox.xpi (signed v${version})`)
}

async function main() {
  if (!hasKeys()) {
    console.log('sign-firefox: no AMO_JWT_ISSUER/AMO_JWT_SECRET, leaving the unsigned build only')
    return
  }
  let found = await findVersion()
  if (!found) {
    console.log(`sign-firefox: uploading v${version}`)
    await submit()
  } else {
    console.log(`sign-firefox: v${version} is already on AMO (${found.file?.status ?? 'processing'})`)
  }
  const file = await until('signing', async () => {
    found = await findVersion()
    if (found?.file?.status === 'disabled') throw new Error(`Mozilla refused v${version}`)
    return found?.file?.status === 'public' ? found.file : null
  })
  const res = await amo('GET', file.url)
  writeFileSync(signed, Buffer.from(await res.arrayBuffer()))
  publish()
}

main().catch((err) => {
  // A failed signing must not take the docs site down with it.
  console.error(`sign-firefox: ${err.message}`)
  process.exitCode = process.env.CI ? 0 : 1
})
