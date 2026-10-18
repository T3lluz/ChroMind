/**
 * End-to-end test in Playwright's Chromium with the real extension:
 *
 *   - the panel reads a page; slash menu; the AI picker (rail, models, depths)
 *   - Claude Code and OpenCode's free models through a Bridge this test starts
 *     (its own config folder and port), when those apps are installed
 *   - "Your server": a fake t3lluz dashboard, connected from settings by
 *     address alone, answering in the panel
 *   - claude.ai without a login fails with a sign-in fix
 *   - selection toolbar card, settings page, header rules, docs install box
 *
 *   npm run test:e2e              assertions only
 *   npm run screenshots           also refreshes site/assets/screens/*.png
 *   HEADED=1 npm run test:e2e     watch it
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
const skip = (name, why) => results.push(`- ${name}: skipped (${why})`)
const shot = async (page, name, opts = {}) => {
  if (SCREENSHOTS) await page.screenshot({ path: join(shots, name), ...opts })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- fixtures: an article, and a fake t3lluz dashboard ---------- */

const site = createServer((req, res) => {
  if (req.url === '/echo') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ origin: req.headers.origin ?? null }))
  }
  if (req.url === '/_api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, at: 1 }))
  }
  if (req.url === '/_api/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'claude:sonnet' }, { id: 'claude:sonnet@xhigh' }, { id: 'cursor:auto' }] }))
  }
  if (req.url === '/_api/v1/chat/completions') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { model } = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
      chunk('Hello from your server')
      chunk(` (${model || "Hermes' model"}).`)
      res.end('data: [DONE]\n\n')
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(resolve(import.meta.dirname, 'fixtures/article.html')))
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const sitePort = site.address().port
const articleUrl = `http://127.0.0.1:${sitePort}/article.html`

/* ---------- a Bridge of our own ---------- */

const BRIDGE_PORT = 8799
const bridgeHome = mkdtempSync(join(tmpdir(), 'chromind-bridge-'))
const bridge = spawn(process.execPath, [resolve(root, 'bridge/chromind-bridge.mjs')], {
  env: { ...process.env, CHROMIND_HOME: bridgeHome, CHROMIND_BRIDGE_PORT: String(BRIDGE_PORT) },
  stdio: 'ignore',
})
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`).then((r) => r.ok).catch(() => false)) break
  await sleep(200)
}
const token = (await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/pair`)).json()).token
const apps = (await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/v1/status`, { headers: { authorization: `Bearer ${token}` } })).json()).providers
const hasClaudeCode = apps['claude-code']?.installed && apps['claude-code'].loggedIn !== false
const hasOpenCode = apps.opencode?.installed

/* ---------- the browser ---------- */

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
    if (patch.providers) {
      next.providers = { ...settings.providers }
      for (const [id, v] of Object.entries(patch.providers)) next.providers[id] = { ...(settings.providers?.[id] ?? {}), ...v }
    }
    await chrome.storage.local.set({ settings: next })
  }, patch)

// No token: the extension pairs with the Bridge by itself.
await setSettings({ provider: 'claude-web', bridge: { url: `http://127.0.0.1:${BRIDGE_PORT}`, token: '' }, theme: 'dark' })

// The welcome page opens on install (and takes focus): wait for it first.
const isWelcome = (p) => p.url().includes('options.html')
const welcome =
  context.pages().find(isWelcome) ?? (await context.waitForEvent('page', { predicate: isWelcome, timeout: 15000 }).catch(() => null))

const article = await context.newPage()
await article.goto(articleUrl)
const { windowId } = await sw.evaluate(async (url) => {
  const [tab] = await chrome.tabs.query({ url })
  await chrome.tabs.update(tab.id, { active: true })
  return { windowId: tab.windowId }
}, articleUrl)

const panelPromise = context.waitForEvent('page', (p) => p.url().includes('sidepanel.html'))
await sw.evaluate(({ url }) => chrome.windows.create({ url, type: 'popup', width: 400, height: 780 }), {
  url: extUrl(`sidepanel/sidepanel.html?window=${windowId}`),
})
const panel = await panelPromise
await panel.setViewportSize({ width: 400, height: 780 })
await panel.waitForLoadState('domcontentloaded')

await step('panel reads the active tab', async () => {
  await panel.waitForFunction(() => document.getElementById('ctxTitle').textContent.includes('night train'), null, { timeout: 10000 })
  assert.equal(await panel.locator('#ctxToggle').getAttribute('aria-pressed'), 'true')
  assert.ok((await panel.locator('.action-row').count()) >= 5)
  assert.equal(await panel.locator('#aiModel').innerText(), 'Claude')
  await shot(panel, 'panel-welcome.png')
})

await step('slash menu lists actions', async () => {
  await panel.locator('#input').fill('/sum')
  await panel.waitForSelector('#slashMenu:not([hidden]) [data-slash="summarize"]')
  await panel.locator('#input').fill('')
  await panel.keyboard.press('Escape')
})

const openPicker = async () => {
  if (await panel.locator('#picker').isHidden()) await panel.locator('#aiPill').click()
  await panel.waitForSelector('#picker:not([hidden]) .rail-item')
}

await step('AI picker: providers with logos, Bridge apps ready without a token', async () => {
  await openPicker()
  assert.ok((await panel.locator('.rail-item').count()) >= 9)
  assert.ok((await panel.locator('.rail-item .brand-logo').count()) >= 9)
  // Claude Code's readiness comes from the Bridge, paired just now.
  await panel.locator('[data-rail="claude-code"]').click()
  // Switching providers re-renders the rail; the picker must stay open.
  assert.ok(await panel.locator('#picker').isVisible())
  if (hasClaudeCode) {
    await panel.waitForSelector('.model-row[data-family="haiku"]', { timeout: 30000 })
  } else {
    await panel.waitForSelector('.setup-card')
  }
  await panel.keyboard.press('Escape')
})

const waitForAnswer = async (n) => {
  await panel.waitForFunction(
    (n) => [...document.querySelectorAll('.msg-assistant')].filter((el) => !el.classList.contains('streaming')).length >= n,
    n,
    { timeout: 180000 },
  )
  const last = panel.locator('.msg-assistant').nth(n - 1)
  const error = (await last.locator('.msg-error').isVisible()) ? await last.locator('.msg-error').innerText() : ''
  return { text: await last.locator('.md').innerText(), error }
}
let answers = 0

if (hasClaudeCode) {
  await step('pick Claude Haiku at Low depth in the picker', async () => {
    await openPicker()
    await panel.locator('[data-rail="claude-code"]').click()
    await panel.locator('.model-row[data-family="haiku"] [data-pick]').click()
    await panel.waitForSelector('.model-row[data-family="haiku"] .depth-chip[data-depth="low"]')
    await panel.locator('.model-row[data-family="haiku"] .depth-chip[data-depth="low"]').click()
    await panel.waitForFunction(() => document.getElementById('aiModel').textContent === 'Claude Haiku · Low')
    assert.equal(await panel.locator('#aiProvider').innerText(), 'Claude Code')
  })

  await step('Summarize through Claude Code: working scanner, then the answer', async () => {
    await panel.locator('.action-row[data-action="summarize"]').click()
    await panel.waitForSelector('.msg-assistant .working:not([hidden]) .cm-scanner, .msg-assistant:not(.streaming)', { timeout: 30000 })
    const { text, error } = await waitForAnswer(++answers)
    assert.equal(error, '')
    assert.match(text, /night|sleeper|train/i)
    await panel.locator('#scroller').evaluate((s) => (s.scrollTop = 0))
    await shot(panel, 'panel-answer.png')
  })

  await step('follow-up keeps the context', async () => {
    await panel.locator('#input').fill('In one sentence: what makes tickets expensive?')
    await panel.keyboard.press('Enter')
    const { text, error } = await waitForAnswer(++answers)
    assert.equal(error, '')
    assert.match(text, /fee|access|track|staff/i)
  })
} else skip('Claude Code answers', 'Claude Code is not installed or signed in here')

if (hasOpenCode) {
  await step("OpenCode's free model answers through the OpenCode app", async () => {
    await panel.locator('#newChatBtn').click()
    await openPicker()
    await panel.locator('[data-rail="opencode"]').click()
    await panel.waitForSelector('.model-row[data-family="big-pickle"]', { timeout: 30000 })
    await panel.locator('.model-row[data-family="big-pickle"] [data-pick]').click()
    await panel.waitForFunction(() => document.getElementById('aiProvider').textContent === 'OpenCode')
    await panel.locator('#ctxToggle').click()
    await panel.locator('#input').fill('Reply with one word: ready')
    await panel.keyboard.press('Enter')
    answers = 0
    const { text, error } = await waitForAnswer(++answers)
    assert.equal(error, '')
    assert.ok(text.trim().length > 0)
    await panel.locator('#ctxToggle').click()
  })
} else skip('OpenCode free model', 'the OpenCode app is not installed here')

await step('your server: connect by address in settings, then chat through it', async () => {
  const page = welcome ?? (await context.newPage())
  await page.setViewportSize({ width: 1180, height: 900 })
  await page.goto(extUrl('options/options.html#provider-hermes'))
  await page.locator('[data-field="hermes.address"]').fill(`fredde@127.0.0.1:${sitePort}`)
  await page.locator('#provider-hermes [data-connect]').click()
  await page.waitForSelector('#provider-hermes [data-status].ok', { timeout: 20000 })
  assert.match(await page.locator('#provider-hermes [data-connect-status]').innerText(), /Your dashboard on 127\.0\.0\.1/)

  await panel.locator('#newChatBtn').click()
  await panel.waitForFunction(() => document.getElementById('aiModel').textContent === "Hermes' model")
  await openPicker()
  await panel.waitForSelector('.model-row[data-family="claude:sonnet"]', { timeout: 20000 })
  assert.ok(await panel.locator('.list-head.small', { hasText: 'On your server' }).count())
  await panel.locator('.model-row[data-family="claude:sonnet"] [data-pick]').click()
  await panel.locator('.model-row[data-family="claude:sonnet"] .depth-chip[data-depth="xhigh"]').click()
  await panel.locator('#ctxToggle').click()
  await panel.locator('#input').fill('Hi')
  await panel.keyboard.press('Enter')
  answers = 0
  const { text, error } = await waitForAnswer(++answers)
  assert.equal(error, '')
  assert.equal(text.trim(), 'Hello from your server (claude:sonnet@xhigh).')
  await panel.locator('#ctxToggle').click()
})

await step('claude.ai without a login shows a sign-in fix, not a crash', async () => {
  await setSettings({ provider: 'claude-web' })
  await panel.locator('#newChatBtn').click()
  await panel.locator('#input').fill('Hello')
  await panel.keyboard.press('Enter')
  await panel.waitForSelector('.msg-error:not([hidden])', { timeout: 30000 })
  assert.match(await panel.locator('.msg-error').innerText(), /claude\.ai/i)
})

await step('light theme with the picker open', async () => {
  await setSettings({ theme: 'light', provider: hasClaudeCode ? 'claude-code' : 'hermes' })
  await panel.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await panel.locator('#historyBtn').click()
  await panel.waitForSelector('#historyDrawer:not([hidden]) .history-item')
  await panel.locator('.history-item').last().click()
  await openPicker()
  await sleep(600)
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
}

const textOf = (node) => (node.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('').trim()

if (hasClaudeCode) {
  await step('selection toolbar answers in a card', async () => {
    await setSettings({ provider: 'claude-code', providers: { 'claude-code': { model: 'haiku@low' } } })
    await article.bringToFront()
    await article.setViewportSize({ width: 1180, height: 760 })
    const box = await article.evaluate(() => {
      const p = document.querySelectorAll('article p')[1]
      const range = document.createRange()
      range.setStart(p.firstChild, 0)
      range.setEnd(p.firstChild, 120)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
      const r = range.getBoundingClientRect()
      return { x: r.right - 4, y: r.bottom - 4 }
    })
    await article.mouse.move(box.x, box.y)
    await article.mouse.up()
    await sleep(400)
    await clickInShadow(article, (n) => n.nodeName === 'BUTTON' && textOf(n) === 'Explain')
    const cdp = await context.newCDPSession(article)
    let done = false
    for (let i = 0; i < 180 && !done; i++) {
      await sleep(1000)
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
} else skip('selection toolbar card', 'needs Claude Code')

await step('settings page: provider cards, server connected, Bridge paired', async () => {
  const page = context.pages().find((p) => p.url().includes('options.html')) ?? (await context.newPage())
  await page.goto(extUrl('options/options.html'))
  await page.waitForSelector('#provider-claude-web')
  assert.equal(await page.locator('.pcard').count(), 10)
  await page.waitForSelector('#bridgeStatus .pill.ok', { timeout: 60000 })
  await page.evaluate(() => scrollTo(0, 0))
  await sleep(500)
  await shot(page, 'options.png')
})

await step('extension requests to servers carry no Origin (panel and tabbed pages)', async () => {
  const echo = articleUrl.replace('article.html', 'echo')
  const post = (url) => fetch(url, { method: 'POST', body: '{}' }).then((r) => r.json())
  assert.equal((await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length, 4)
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
  for (let i = 0; i < 50 && !(await docsUp()); i++) await sleep(200)
}

await step('docs install page shows the installed version, then an update', async () => {
  const { version } = JSON.parse(readFileSync(resolve(ext, 'manifest.json'), 'utf8'))
  const page = await context.newPage()
  await page.goto(`${DOCS}docs/install/`)
  const box = page.locator('[data-install-status]')
  await box.waitFor({ state: 'visible', timeout: 10000 })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.chromindVersion), version)
  assert.equal(await box.locator('strong').innerText(), `ChroMind v${version} is installed in this browser.`)
  await page.route('**/chromind-chrome.json', (route) =>
    route.fulfill({ json: { version: '99.0.0', fingerprint: '0'.repeat(64), zip: 'chromind-chrome.zip' } }),
  )
  await page.reload()
  await page.waitForSelector('[data-install-status].update:not([hidden])', { timeout: 10000 })
  assert.equal(await box.locator('strong').innerText(), 'Update available: v99.0.0')
  await page.close()
})

await step('settings: Updates offers the new zip and a reload', async () => {
  await context.route('**/chromind-chrome.json', (route) =>
    route.fulfill({ json: { version: '99.0.0', fingerprint: '0'.repeat(64), zip: 'chromind-chrome.zip' } }),
  )
  await panel.evaluate(() => chrome.storage.local.remove('updateInfo'))
  const page = await context.newPage()
  await page.goto(extUrl('options/options.html#updates'))
  await page.waitForFunction(() => document.getElementById('updateTitle').textContent.includes('99.0.0'), null, { timeout: 10000 })
  assert.ok(await page.locator('#updateDownload').isVisible())
  assert.match(await page.locator('#updateDownload').getAttribute('href'), /chromind-chrome\.zip\?v=99\.0\.0$/)
  assert.ok(await page.locator('#reloadExt').isVisible())
  await page.close()
  await context.unroute('**/chromind-chrome.json')
})

await step('the open panel still gets requests after the service worker restarts', async () => {
  const now = Date.now()
  const thread = {
    id: 'e2e-inline',
    title: 'From the card',
    createdAt: now,
    updatedAt: now,
    providerState: {},
    messages: [
      { id: 'u1', role: 'user', createdAt: now, text: 'Card question', contexts: [] },
      { id: 'a1', role: 'assistant', createdAt: now, text: `See [the article](${articleUrl}).`, providerName: 'Test' },
    ],
  }
  await panel.evaluate((t) => chrome.storage.session.set({ [`inline:${t.id}`]: t }), thread)
  // Stopping the worker takes its port to the panel down with it, as an idle stop does.
  const cdp = await context.newCDPSession(panel)
  const { targetInfos } = await cdp.send('Target.getTargets')
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId))
  await cdp.send('Target.closeTarget', { targetId: worker.targetId })
  await sleep(500)
  const page = await context.newPage()
  await page.goto(extUrl('options/options.html'))
  const res = await page.evaluate(async (windowId) => {
    const tab = await chrome.tabs.getCurrent()
    if (tab.windowId !== windowId) return { wrongWindow: tab.windowId }
    return chrome.runtime.sendMessage({ type: 'open-thread', threadId: 'e2e-inline' })
  }, windowId)
  assert.deepEqual(res, { opened: true })
  await panel.waitForFunction(() => document.getElementById('messages').textContent.includes('Card question'), null, {
    timeout: 10000,
  })
  // A link to a page that's already open switches to its tab instead of opening another.
  const before = context.pages().length
  await panel.locator('.md a').first().click()
  await sleep(600)
  assert.equal(context.pages().length, before)
  const active = await page.evaluate((windowId) => chrome.tabs.query({ active: true, windowId }), windowId)
  assert.equal(active[0].url, articleUrl)
  await page.close()
})

await step('no uncaught errors in extension pages', async () => {
  assert.deepEqual(errors, [])
})

await context.close()
site.close()
bridge.kill()
docsServer?.kill()
rmSync(profile, { recursive: true, force: true })
rmSync(bridgeHome, { recursive: true, force: true })
console.log(results.join('\n'))
if (SCREENSHOTS) console.log(`Screenshots: ${shots}`)
