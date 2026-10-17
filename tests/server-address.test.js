import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hermesNeedsBridge, parseServerAddress } from '../extension/lib/server-address.js'
import { parseSshTarget } from '../bridge/chromind-bridge.mjs'

describe('parseServerAddress', () => {
  it('parses user@host and user@ip:port like TileSmith / DailyDash', () => {
    assert.deepEqual(parseServerAddress('you@box'), {
      kind: 'ssh',
      user: 'you',
      host: 'box',
      port: 22,
      display: 'you@box',
    })
    assert.equal(parseServerAddress('fredrik@100.64.1.5:2222').port, 2222)
    assert.equal(parseServerAddress('ssh://alice@nas.tailnet.ts.net').user, 'alice')
    assert.equal(parseServerAddress('ssh bob@host -p 2200').port, 2200)
  })

  it('treats bare hosts and http URLs as direct Hermes API', () => {
    assert.deepEqual(parseServerAddress('127.0.0.1'), {
      kind: 'http',
      baseUrl: 'http://127.0.0.1:8642',
      display: '127.0.0.1:8642',
    })
    assert.equal(parseServerAddress('http://127.0.0.1:8642').kind, 'http')
    assert.equal(parseServerAddress('https://hermes.example.com/v1').baseUrl, 'https://hermes.example.com/v1')
  })

  it('rejects bad input', () => {
    assert.equal(parseServerAddress('').kind, 'empty')
    assert.equal(parseServerAddress('@host').kind, 'error')
    assert.equal(parseServerAddress('you@').kind, 'error')
  })

  it('marks SSH addresses as needing the Bridge', () => {
    assert.equal(hermesNeedsBridge('you@server'), true)
    assert.equal(hermesNeedsBridge('http://127.0.0.1:8642'), false)
  })
})

describe('parseSshTarget (Bridge)', () => {
  it('matches the extension parser for SSH forms', () => {
    assert.deepEqual(parseSshTarget('you@100.64.0.1'), {
      user: 'you',
      host: '100.64.0.1',
      port: 22,
      display: 'you@100.64.0.1',
    })
    assert.match(parseSshTarget('no-user').error, /user name/i)
  })
})
