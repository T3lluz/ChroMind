import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeParser, cursorParser, flatten } from '../bridge/chromind-bridge.mjs'

const collect = (make, lines) => {
  const events = []
  const parser = make((e) => events.push(e))
  for (const line of lines) parser.line(JSON.stringify(line))
  return { events, parser }
}

test('Claude Code: text and thinking deltas stream, result is not doubled', () => {
  const { events, parser } = collect(claudeParser, [
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'hello world' },
  ])
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'hmm' },
    { type: 'text', text: 'hello ' },
    { type: 'text', text: 'world' },
  ])
  assert.equal(parser.result().text, 'hello world')
  assert.equal(parser.error(), null)
})

test('Claude Code: errors in the result line surface', () => {
  const { parser } = collect(claudeParser, [{ type: 'result', is_error: true, result: 'Not logged in' }])
  assert.equal(parser.error(), 'Not logged in')
})

test('Cursor: only timestamped deltas without model_call_id are new text', () => {
  const { events, parser } = collect(cursorParser, [
    { type: 'system', subtype: 'init' },
    { type: 'thinking', subtype: 'delta', text: 'The' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, timestamp_ms: 1 },
    { type: 'assistant', message: { content: [{ type: 'text', text: ' from' }] }, timestamp_ms: 2 },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello from' }] }, timestamp_ms: 3, model_call_id: 'x' },
    { type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'request.md' } } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello from' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'hello from' },
  ])
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'The' },
    { type: 'text', text: 'hello' },
    { type: 'text', text: ' from' },
    { type: 'tool', name: 'read' },
  ])
  assert.equal(parser.result().text, 'hello from')
})

test('flatten turns a chat into a system prompt and one request', () => {
  const { system, prompt } = flatten([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: 'Hello!' },
    { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
  ])
  assert.equal(system, 'Be terse.')
  assert.match(prompt, /<conversation_so_far>\nUser: Hi\n\nAssistant: Hello!\n\n<\/conversation_so_far>/)
  assert.match(prompt, /And now\?$/)
})
