import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { detectServer, parseServerAddress, serverChatBase, serverModels, splitServerModel } from '../extension/lib/providers/server.js'

test('what people type for a server', () => {
  assert.deepEqual(parseServerAddress('fredde@100.64.0.5'), { host: '100.64.0.5', port: null })
  assert.deepEqual(parseServerAddress('ssh fredde@box -p 2222'), { host: 'box', port: null })
  assert.deepEqual(parseServerAddress('box:8642'), { host: 'box', port: 8642 })
  assert.deepEqual(parseServerAddress('me@[fd7a::1]:22'), { host: 'fd7a::1', port: null })
  assert.equal(parseServerAddress('https://t3lluz.com').host, 't3lluz.com')
  assert.ok(parseServerAddress('').error)
  assert.ok(parseServerAddress('not a host').error)
})

test('dashboard model ids', () => {
  assert.deepEqual(splitServerModel('claude:sonnet@xhigh'), { source: 'claude', model: 'sonnet@xhigh' })
  assert.deepEqual(splitServerModel('hermes-agent'), { source: '', model: 'hermes-agent' })
})

/* A fake dashboard (/_api) and a fake Hermes API server on loopback. */
let dashboard
let hermes
const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(server))
  })
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

before(async () => {
  dashboard = await listen((req, res) => {
    if (req.url === '/_api/health') return json(res, 200, { ok: true, at: 1 })
    if (req.url === '/_api/v1/models') return json(res, 200, { data: [{ id: 'claude:sonnet' }, { id: 'cursor:auto' }] })
    json(res, 404, {})
  })
  hermes = await listen((req, res) => {
    if (req.url === '/health') return json(res, 200, { status: 'ok' })
    if (req.url === '/v1/models') {
      return req.headers.authorization === 'Bearer sekret'
        ? json(res, 200, { data: [{ id: 'hermes-agent' }] })
        : json(res, 401, { error: { message: 'bad key' } })
    }
    json(res, 404, {})
  })
})

after(() => {
  dashboard.close()
  hermes.close()
})

test('finds a dashboard by its /_api and lists its models', async () => {
  const found = await detectServer({ address: `you@127.0.0.1:${dashboard.address().port}` })
  assert.equal(found.kind, 'dashboard')
  assert.match(found.base, /\/_api$/)
  assert.deepEqual(await serverModels(found), ['claude:sonnet', 'cursor:auto'])
  assert.match(serverChatBase(found), /\/_api\/v1$/)
})

test('finds Hermes and checks its password', async () => {
  const address = `127.0.0.1:${hermes.address().port}`
  const found = await detectServer({ address, password: 'sekret' })
  assert.equal(found.kind, 'hermes')
  assert.deepEqual(await serverModels(found, 'sekret'), ['hermes-agent'])
  assert.match(serverChatBase(found, 'browser'), /\/p\/browser\/v1$/)
  await assert.rejects(detectServer({ address, password: 'wrong' }), /didn't accept that password/)
})

test('says what to do when nothing answers', async () => {
  await assert.rejects(detectServer({ address: '127.0.0.1:9' }), (err) => {
    assert.match(err.message, /Nothing answered/)
    assert.match(err.fix, /API_SERVER_HOST=0\.0\.0\.0/)
    return true
  })
})
