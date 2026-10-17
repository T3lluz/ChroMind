import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSSE } from '../extension/lib/sse.js'
import { endpoint } from '../extension/lib/providers/openai.js'

function streamOf(chunks) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    }),
  )
}

test('parses events split across chunks, CRLF, comments and named events', async () => {
  const res = streamOf([
    ': keepalive\n\n',
    'data: {"a":',
    '1}\r\n\r\nevent: hermes.tool.progress\ndata: {"tool":"web_search"}\n\n',
    'data: line1\ndata: line2\n\n',
    'data: [DONE]',
  ])
  const events = []
  for await (const e of readSSE(res)) events.push(e)
  assert.deepEqual(events, [
    { event: 'message', data: '{"a":1}' },
    { event: 'hermes.tool.progress', data: '{"tool":"web_search"}' },
    { event: 'message', data: 'line1\nline2' },
    { event: 'message', data: '[DONE]' },
  ])
})

test('endpoint adds /v1 unless a version is there, and supports Hermes profiles', () => {
  assert.equal(endpoint('http://127.0.0.1:8642', '/chat/completions'), 'http://127.0.0.1:8642/v1/chat/completions')
  assert.equal(endpoint('https://openrouter.ai/api/v1/', '/models'), 'https://openrouter.ai/api/v1/models')
  assert.equal(endpoint('http://h:8642', '/models', 'browser'), 'http://h:8642/p/browser/v1/models')
})
