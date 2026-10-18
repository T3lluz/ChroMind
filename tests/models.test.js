import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brandFor } from '../extension/lib/brands.js'
import { groupModels, isFree, locate, modelTitle, pickVariant, prettyModel, splitVariant } from '../extension/lib/models.js'

test('Cursor-style ids split into family, depth and fast', () => {
  assert.deepEqual(splitVariant('claude-opus-5-5-high-fast'), { family: 'claude-opus-5-5', depth: 'high', fast: true })
  assert.deepEqual(splitVariant('gpt-5.5-extra-high'), { family: 'gpt-5.5', depth: 'xhigh', fast: false })
  assert.deepEqual(splitVariant('composer-2.5'), { family: 'composer-2.5', depth: '', fast: false })
  assert.deepEqual(splitVariant('opus@med'), { family: 'opus', depth: 'med', fast: false })
  assert.deepEqual(splitVariant('claude:sonnet@xhigh'), { family: 'claude:sonnet', depth: 'xhigh', fast: false })
})

test('readable model names', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Claude Opus 5.5')
  assert.equal(prettyModel('gpt-5.6-sol'), 'GPT-5.6 Sol')
  assert.equal(prettyModel('cursor-grok-4.5'), 'Grok 4.5')
  assert.equal(prettyModel('glm-5.2'), 'GLM 5.2')
  assert.equal(prettyModel('meta-llama/llama-3.3-70b-instruct:free'), 'Llama 3.3 70b Instruct')
})

test('families gather their depths; CLI depths are added as @variants', () => {
  const cursor = groupModels(['auto', 'claude-opus-5-5-low', 'claude-opus-5-5-high', 'claude-opus-5-5-high-fast'])
  assert.equal(cursor.length, 2)
  assert.deepEqual(cursor[1].depths, ['low', 'high'])
  assert.equal(cursor[1].hasFast, true)

  const claude = groupModels([{ id: 'opus', label: 'Claude Opus' }], { depths: ['low', 'high', 'max'] })
  assert.deepEqual(
    claude[0].variants.map((v) => v.id),
    ['opus', 'opus@low', 'opus@high', 'opus@max'],
  )
  assert.equal(claude[0].label, 'Claude Opus')
})

test('picking a depth keeps the closest variant', () => {
  const [fam] = groupModels(['m-low', 'm-medium', 'm-max', 'm-max-fast'])
  assert.equal(pickVariant(fam, 'high', false).id, 'm-medium')
  assert.equal(pickVariant(fam, 'max', true).id, 'm-max-fast')
  assert.equal(pickVariant(fam, '', false).id, 'm-medium')
})

test('titles name the depth', () => {
  const groups = groupModels([{ id: 'opus', label: 'Claude Opus' }], { depths: ['high'] })
  assert.equal(modelTitle(groups, 'opus@high'), 'Claude Opus · High')
  assert.equal(modelTitle(groups, 'opus'), 'Claude Opus')
  assert.ok(locate(groups, 'opus@high'))
  assert.equal(modelTitle([], 'gemini-3.7-flash'), 'Gemini 3.7 Flash')
})

test('free models and makers', () => {
  assert.ok(isFree('big-pickle'))
  assert.ok(isFree('nemotron-3.5-lightning-free'))
  assert.ok(isFree('deepseek/deepseek-r1:free'))
  assert.ok(!isFree('gpt-5.5'))
  assert.equal(brandFor('claude-opus-5-5-high'), 'claude')
  assert.equal(brandFor('gpt-5.6-sol-high'), 'openai')
  assert.equal(brandFor('composer-2.5'), 'cursor')
  assert.equal(brandFor('kimi-k3-max'), 'kimi')
  assert.equal(brandFor('something-new', 'groq'), 'groq')
})
