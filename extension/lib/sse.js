/**
 * Reads a text/event-stream response body and yields { event, data } for
 * each event. Handles \r\n, multi-line data and `:` keepalive comments
 * (Hermes sends one every 10 seconds of silence).
 */
export async function* readSSE(response, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let data = []
  const flush = function* () {
    if (data.length) yield { event, data: data.join('\n') }
    event = 'message'
    data = []
  }
  try {
    for (;;) {
      if (signal?.aborted) throw abortError()
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1))
        if (line === '') {
          yield* flush()
        } else if (line.startsWith(':')) {
          // comment / keepalive
        } else {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let value = colon === -1 ? '' : line.slice(colon + 1)
          if (value.startsWith(' ')) value = value.slice(1)
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        else if (line.startsWith('event:')) event = line.slice(6).trim()
      }
    }
    yield* flush()
  } finally {
    reader.releaseLock?.()
  }
}

export function abortError() {
  return new DOMException('Stopped', 'AbortError')
}

export function parseJSON(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
