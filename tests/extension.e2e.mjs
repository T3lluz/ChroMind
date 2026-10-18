/**
 * End-to-end smoke test in Playwright's Chromium with the real extension:
 * side panel reads a page, quick action and follow-up answer through
 * ChroMind Bridge (when it's running), slash menu, claude.ai sign-in error
 * path, selection toolbar card, settings page, and the docs install page
 * (served by scripts/build-site.mjs --serve) seeing the installed version.
 *
 *   npm run test:e2e              assertions only
 *   npm run screenshots           also refreshes site/assets/screens/*.png
 *   HEADED=1 npm run test:e2e     watch it
 *
 * Bridge tests need `node bridge/chromind-bridge.mjs` running with a
 * signed-in Claude Code CLI; without it they're skipped.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const ext = resolve(root, 'extension')
const shots = resolve(root, 'site/assets/screens')
const SCREENSHOTS = process.argv.includes('--screenshots')
mkdirSync(shots, { recursive: true })

const results = []
async function step(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push(`✔ ${name} (${Date.now() - started} ms)`)
  } catch (err) {
    results.push(`✖ ${name}: ${err.message.split('\n')[0]}`)
    process.exitCode = 1
  }
}
const shot = async (page, name, opts = {}) => {
  if (SCREENSHOTS) await page.screenshot({ path: join(shots, name), ...opts })
}

// A tiny site with an article on it.
const server = createServer((req, res) => {
  if (req.url === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ origin: req.headers.origin ?? null }))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(resolve(import.meta.dirname, 'fixtures/article.html')))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const articleUrl = `http://127.0.0.1:${server.address().port}/article.html`

const bridgeUp = await fetch('http://127.0.0.1:8765/health')
  .then((r) => r.ok)
  .catch(() => false)
const token = bridgeUp ? execFileSync(process.execPath, [resolve(root, 'bridge/chromind-bridge.mjs'), 'token'], { encoding: 'utf8' }).trim() : ''

const profile = mkdtempSync(join(tmpdir(), 'chromind-e2e-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  viewport: { width: 1180, height: 760 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
})
const errors = []
context.on('weberror', (e) => errors.push(e.error().message))

let [sw] = context.serviceWorkers()
sw ??= await context.waitForEvent('serviceworker')
const extId = new URL(sw.url()).host
const extUrl = (path) => `chrome-extension://${extId}/${path}`

const setSettings = (patch) =>
  sw.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get('settings')
    const next = { ...settings, ...patch }
    if (patch.providers) next.providers = { ...settings.providers, ...patch.providers }
    await chrome.storage.local.set({ settings: next })
  }, patch)

await setSettings({
  provider: bridgeUp ? 'claude-code' : 'claude-web',
  providers: { 'claude-code': { model: 'haiku' } },
  bridge: { url: 'http://127.0.0.1:8765', token },
  theme: 'dark',
})

// The welcome page opens on install (and takes focus): wait for it before
// opening the article, and keep it for the settings screenshot.
const isWelcome = (p) => p.url().includes('options.html')
const welcome =
  context.pages().find(isWelcome) ??
  (await context.waitForEvent('page', { predicate: isWelcome, timeout: 15000 }).catch(() => null))

const article = await context.newPage()
await article.goto(articleUrl)
const { windowId } = await sw.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url })
  await chrome.tabs.update(tab.id, { active: true })
  return { windowId: tab.windowId }
}, articleUrl)

// The panel as a pop-out window that follows the article's window.
const panelPromise = context.waitForEvent('page', (p) => p.url().includes('sidepanel.html'))
await sw.evaluate(
  ({ url }) => chrome.windows.create({ url, type: 'popup', width: 400, height: 780 }),
  { url: extUrl(`sidepanel/sidepanel.html?window=${windowId}`) },
)
const panel = await panelPromise
await panel.setViewportSize({ width: 400, height: 780 })
await panel.waitForLoadState('domcontentloaded')

await step('panel reads the active tab', async () => {
  await panel.waitForFunction(() => document.getElementById('ctxTitle').textContent.includes('night train'), null, { timeout: 10000 })
  assert.equal(await panel.locator('#ctxToggle').getAttribute('aria-pressed'), 'true')
  assert.ok((await panel.locator('.action-card').count()) >= 5)
  await shot(panel, 'panel-welcome.png')
})

await step('slash menu lists actions', async () => {
  await panel.locator('#input').fill('/sum')
  await panel.waitForSelector('#slashMenu:not([hidden]) [data-slash="summarize"]')
  await panel.locator('#input').fill('')
  await panel.keyboard.press('Escape')
})

const waitForAnswer = async (n) => {
  await panel.waitForFunction(
    (n) => {
      const done = [...document.querySelectorAll('.msg-assistant')].filter((el) => !el.classList.contains('streaming'))
      return done.length >= n
    },
    n,
    { timeout: 180000 },
  )
  const last = panel.locator('.msg-assistant').nth(n - 1)
  const error = (await last.locator('.msg-error').isVisible()) ? await last.locator('.msg-error').innerText() : ''
  return { text: await last.locator('.md').innerText(), error }
}

if (bridgeUp) {
  await step('Summarize via Claude Code (Bridge) reads the article', async () => {
    await panel.locator('.action-card[data-action="summarize"]').click()
    const { text, error } = await waitForAnswer(1)
    assert.equal(error, '')
    assert.match(text, /night|sleeper|train/i)
    await panel.locator('#scroller').evaluate((s) => (s.scrollTop = 0))
    await shot(panel, 'panel-answer.png')
  })

  await step('follow-up keeps the context', async () => {
    await panel.locator('#input').fill('In one sentence: what makes tickets expensive?')
    await panel.keyboard.press('Enter')
    const { text, error } = await waitForAnswer(2)
    assert.equal(error, '')
    assert.match(text, /fee|access|track|staff/i)
  })
} else {
  results.push('- Bridge tests skipped: start node bridge/chromind-bridge.mjs to run them')
}

await step('claude.ai without a login shows a sign-in fix, not a crash', async () => {
  await setSettings({ provider: 'claude-web' })
  await panel.locator('#newChatBtn').click()
  await panel.locator('#input').fill('Hello')
  await panel.keyboard.press('Enter')
  await panel.waitForSelector('.msg-error:not([hidden])', { timeout: 30000 })
  const message = await panel.locator('.msg-error').innerText()
  assert.match(message, /claude\.ai/i)
})

await step('light theme and provider menu', async () => {
  await setSettings({ theme: 'light', provider: bridgeUp ? 'claude-code' : 'claude-web' })
  await panel.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await panel.locator('#historyBtn').click()
  await panel.waitForSelector('#historyDrawer:not([hidden]) .history-item')
  const items = await panel.locator('.history-item').count()
  assert.ok(items >= 1, 'history lists the chats')
  await panel.locator('#historyClose').click()
  // Show the summary chat again for the screenshot.
  await panel.locator('#historyBtn').click()
  await panel.locator('.history-item').last().click()
  await panel.locator('#providerBtn').click()
  await panel.waitForSelector('#providerMenu:not([hidden])')
  await shot(panel, 'panel-light.png')
  await panel.keyboard.press('Escape')
  await setSettings({ theme: 'dark' })
})

/** Closed shadow roots: find a node through CDP and click its box. */
async function clickInShadow(page, predicate) {
  const cdp = await context.newCDPSession(page)
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
  const found = []
  const walk = (node) => {
    if (predicate(node)) found.push(node)
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child)
  }
  walk(doc)
  assert.ok(found.length, 'element not found in shadow root')
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: found[0].backendNodeId })
  const [x1, y1, , , x3, y3] = model.content
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2)
  return cdp
}

const textOf = (node) => (node.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('').trim()

if (bridgeUp) {
  await step('selection toolbar answers in a card', async () => {
    await article.bringToFront()
    await article.setViewportSize({ width: 1180, height: 760 })
    const box = await article.evaluate(() => {
      const p = document.querySelectorAll('article p')[3]
      const range = document.createRange()
      range.setStart(p.firstChild, 0)
      range.setEnd(p.firstChild, 168)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      const r = range.getBoundingClientRect()
      return { x: r.right - 4, y: r.bottom - 4 }
    })
    await article.mouse.move(box.x, box.y)
    await article.mouse.up()
    await article.waitForTimeout(400)
    await clickInShadow(article, (n) => n.nodeName === 'BUTTON' && textOf(n) === 'Explain')
    const cdp = await context.newCDPSession(article)
    let done = false
    for (let i = 0; i < 180 && !done; i++) {
      await article.waitForTimeout(1000)
      const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })
      const stack = [doc]
      while (stack.length) {
        const n = stack.pop()
        const attrs = n.attributes ?? []
        if (n.nodeName === 'DIV' && attrs[attrs.indexOf('class') + 1] === 'foot' && !attrs.includes('hidden')) done = true
        stack.push(...(n.children ?? []), ...(n.shadowRoots ?? []))
      }
    }
    assert.ok(done, 'card finished')
    await shot(article, 'selection-card.png')
  })
}

await step('settings page shows providers and a connected Bridge', async () => {
  const page = welcome ?? (await context.newPage())
  await page.setViewportSize({ width: 1180, height: 900 })
  await page.goto(extUrl('options/options.html'))
  await page.waitForSelector('[data-provider="claude-web"]')
  assert.equal(await page.locator('.provider').count(), 5)
  if (bridgeUp) await page.waitForSelector('#bridgeStatus .pill.ok', { timeout: 60000 })
  await page.evaluate(() => scrollTo(0, 0))
  await shot(page, 'options.png')
})

await step('extension requests to servers carry no Origin (panel and tabbed pages)', async () => {
  const echo = articleUrl.replace('article.html', 'echo')
  const post = (url) => fetch(url, { method: 'POST', body: '{}' }).then((r) => r.json())
  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())
  assert.equal(rules.length, 4)
  assert.deepEqual(await panel.evaluate(post, echo), { origin: null })
  const page = context.pages().find((p) => p.url().includes('options.html'))
  assert.deepEqual(await page.evaluate(post, echo), { origin: null })
})

// The docs site on :4173 (reuses a running npm run dev:site).
const DOCS = 'http://localhost:4173/ChroMind/'
const docsUp = () =>
  fetch(DOCS)
    .then((r) => r.ok)
    .catch(() => false)
let docsServer = null
if (!(await docsUp())) {
  docsServer = spawn(process.execPath, [resolve(root, 'scripts/build-site.mjs'), '--serve'], { cwd: root, stdio: 'ignore' })
  for (let i = 0; i < 50 && !(await docsUp()); i++) await new Promise((r) => setTimeout(r, 200))
}

await step('docs install page shows the installed version, then an update', async () => {
  const { version } = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf8'))
  const page = await context.newPage()
  await page.goto(`${DOCS}docs/install/`)
  const box = page.locator('[data-install-status]')
  await box.waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.chromindVersion), version)
  assert.equal(await box.locator('strong').innerText(), `ChroMind v${version} is installed in this browser.`)
  assert.equal(await box.evaluate((el) => el.classList.contains('update')), false)

  // A newer published build turns it into an update box with the download.
  await page.route('**/chromind-chrome.json', (route) =>
    route.fulfill({ json: { version: '99.0.0', fingerprint: '0'.repeat(64), zip: 'chromind-chrome.zip' } }),
  )
  await page.reload()
  await page.waitForSelector('[data-install-status].update:not([hidden])', { timeout: 10000 })
  assert.equal(await box.locator('strong').innerText(), 'Update available: v99.0.0')
  assert.match(await box.locator('a.btn').getAttribute('href'), /chromind-chrome\.zip\?v=99\.0\.0-/)
  await page.close()
})

await step('no uncaught errors in extension pages', async () => {
  assert.deepEqual(errors, [])
})

await context.close()
server.close()
docsServer?.kill()
rmSync(profile, { recursive: true, force: true })
console.log(results.join('\n'))
if (SCREENSHOTS) console.log(`Screenshots: ${shots}`)
