import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actionPrompt,
  allActions,
  contextBlock,
  fillTemplate,
  findAction,
  messageText,
  slashName,
  systemPrompt,
  threadTitle,
  toChatMessages,
} from '../extension/lib/prompts.js'
import { sendableMessages } from '../extension/lib/providers/index.js'
import { DEFAULTS } from '../extension/lib/settings.js'

const settings = { ...DEFAULTS, translateTo: 'Norwegian' }

test('action prompts name their target and translate language', () => {
  const translate = findAction(settings, 'translate')
  assert.equal(actionPrompt(translate, 'selection', settings), 'Translate the selected text into Norwegian. Keep the formatting and meaning. Output only the translation.')
  assert.match(actionPrompt(findAction(settings, 'summarize'), 'youtube', settings), /^Summarize this video\./)
})

test('custom actions join the list with their own placeholders', () => {
  const custom = { ...settings, customActions: [{ id: 'c1', title: 'Roast it', prompt: 'Roast {{target}} ({{title}})', scopes: ['page'] }] }
  const action = findAction(custom, 'c1')
  assert.ok(action.custom)
  assert.equal(actionPrompt(action, 'page', custom, { title: 'Example' }), 'Roast this page (Example)')
  assert.ok(allActions(custom).length > allActions({ customActions: [] }).length)
})

test('unknown placeholders are left alone', () => {
  assert.equal(fillTemplate('{{a}} {{nope}}', { a: 1 }), '1 {{nope}}')
})

test('slash names are url-ish', () => {
  assert.equal(slashName({ title: "Explain like I'm 5" }), '/explain-like-i-m-5')
  assert.equal(slashName({ title: 'Key points' }), '/key-points')
})

test('context blocks wrap untrusted text and escape attributes', () => {
  const block = contextBlock({ kind: 'page', title: 'A "quoted"\ntitle', url: 'https://x.test', text: 'Body', truncated: true })
  assert.match(block, /^<context type="page" title="A  quoted  title" url="https:\/\/x.test">/)
  assert.match(block, /Content was cut to fit/)
  assert.match(block, /<\/context>$/)
})

test('system prompt marks page content as untrusted and sets language', () => {
  const sys = systemPrompt({ ...settings, language: 'German', systemPrompt: 'Be brief.' })
  assert.match(sys, /untrusted data/)
  assert.match(sys, /Always answer in German\./)
  assert.match(sys, /Be brief\.$/)
})

test('chat messages carry contexts and images in OpenAI shape', () => {
  const messages = [
    { role: 'user', text: 'What is this?', contexts: [{ kind: 'page', title: 'T', url: 'u', text: 'page' }], images: [{ dataUrl: 'data:image/jpeg;base64,AA' }] },
    { role: 'assistant', text: 'A page.' },
    { role: 'user', text: 'Thanks' },
  ]
  const out = toChatMessages(messages, { system: 'SYS', images: true })
  assert.equal(out[0].role, 'system')
  assert.equal(out[1].content[0].type, 'image_url')
  assert.match(out[1].content[1].text, /<context type="page"[\s\S]*What is this\?$/)
  assert.deepEqual(out[2], { role: 'assistant', content: 'A page.' })
  assert.equal(toChatMessages(messages)[0].content, messageText(messages[0]))
})

test('failed turns are not sent again', () => {
  const msgs = [
    { role: 'user', text: 'a' },
    { role: 'assistant', text: '', error: { message: 'x' } },
    { role: 'user', text: 'b' },
  ]
  assert.deepEqual(sendableMessages(msgs).map((m) => m.text), ['a', 'b'])
})

test('thread titles prefer the action and page', () => {
  assert.equal(threadTitle({ action: { title: 'Summarize' }, contexts: [{ title: 'News' }] }), 'Summarize · News')
  assert.equal(threadTitle({ text: 'x'.repeat(100) }).length, 78)
})
