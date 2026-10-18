import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isNewer } from '../extension/lib/updates.js'

test('version compare: numeric parts, missing parts count as 0', () => {
  assert.equal(isNewer('0.3.10', '0.3.9'), true)
  assert.equal(isNewer('0.3.1', '0.3.1'), false)
  assert.equal(isNewer('0.3', '0.3.0'), false)
  assert.equal(isNewer('1.0.0', '0.9.9'), true)
  assert.equal(isNewer('0.3.0', '0.3.1'), false)
  assert.equal(isNewer(null, '0.3.1'), false)
})
