#!/usr/bin/env node
/**
 * ChroMind Bridge: lets the ChroMind browser extension use the Claude Code
 * CLI (`claude`) and the Cursor CLI (`cursor-agent`) with the accounts they
 * are already signed in to. One file, no dependencies, Node 20+.
 *
 *   node chromind-bridge.mjs              start (prints the pairing token)
 *   node chromind-bridge.mjs token        print the token
 *   node chromind-bridge.mjs install      start with your computer (Windows, macOS, Linux)
 *   node chromind-bridge.mjs uninstall    undo `install`
 *
 * It serves an OpenAI-compatible API on 127.0.0.1:8765:
 *
 *   GET  /health                public, { ok, name, version }
 *   GET  /v1/status             CLIs found, versions, sign-in state, models
 *   GET  /v1/models
 *   POST /v1/chat/completions   model "claude-code/<model>" or "cursor/<model>",
 *                               streaming (SSE) or not
 *
 * Every /v1 call needs "Authorization: Bearer <token>". The token lives in
 * ~/.chromind/bridge.json. Requests from web pages are refused (their
 * Origin is http/https); only the extension and local tools get in.
 *
 * Safety: page text is untrusted. Claude Code runs with every tool turned
 * off (--tools "") and Cursor in read-only ask mode, each in an empty
 * scratch folder, so a page can't make them run commands or edit files.
 *
 * Environment: CHROMIND_BRIDGE_PORT, CHROMIND_BRIDGE_HOST, CHROMIND_CLAUDE_BIN,
 * CHROMIND_CURSOR_BIN, CHROMIND_BRIDGE_TIMEOUT (seconds, default 300).
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.1.1'
const CONFIG_DIR = join(homedir(), '.chromind')
const CONFIG = join(CONFIG_DIR, 'bridge.json')
const IS_WIN = platform() === 'win32'
const TIMEOUT_MS = (Number(process.env.CHROMIND_BRIDGE_TIMEOUT) || 300) * 1000
const MAX_CONCURRENT = 3
const MODEL_RE = /^[\w.:@\-/]{1,80}$/

const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku', 'fable']

/* ---------- config ---------- */

function loadConfig() {
  let config = {}
  try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'))
  } catch {
    // first run
  }
  if (!config.token) {
    config.token = randomBytes(24).toString('base64url')
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  }
  return config
}

let config = null
/** Loaded on first use, so importing this file (tests) never writes a token. */
const getConfig = () => (config ??= loadConfig())

/* ---------- finding the CLIs ---------- */

function which(names) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';') : ['']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      for (const ext of IS_WIN ? ['', ...exts] : exts) {
        const path = join(dir, name + ext)
        if (ext === '' && IS_WIN && !/\.\w+$/.test(name)) continue
        if (existsSync(path)) return path
      }
    }
  }
  return null
}

/**
 * How to start a CLI: { cmd, args } with `args` going before ours. On
 * Windows, Cursor's launcher is a .cmd → PowerShell wrapper; we skip it and
 * run its bundled node.exe + index.js directly, so arguments never pass
 * through cmd.exe quoting.
 */
function resolveCursor() {
  if (process.env.CHROMIND_CURSOR_BIN) return launcher(process.env.CHROMIND_CURSOR_BIN)
  const roots = IS_WIN
    ? [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'cursor-agent')]
    : [join(homedir(), '.local/share/cursor-agent')]
  for (const base of roots) {
    const versions = join(base, 'versions')
    if (!existsSync(versions)) continue
    const latest = readdirSync(versions)
      .filter((v) => /^\d{4}\.\d{1,2}\.\d{1,2}/.test(v))
      .sort((a, b) => versionKey(b) - versionKey(a))[0]
    if (!latest) continue
    const node = join(versions, latest, IS_WIN ? 'node.exe' : 'node')
    const index = join(versions, latest, 'index.js')
    if (existsSync(node) && existsSync(index)) return { cmd: node, args: [index], label: `cursor-agent ${latest}` }
  }
  const bin = which(['cursor-agent', 'agent'])
  return bin ? launcher(bin) : null
}

function versionKey(name) {
  const [y, m, d] = name.split('-')[0].split('.').map(Number)
  return y * 10000 + m * 100 + d
}

function resolveClaude() {
  const bin =
    process.env.CHROMIND_CLAUDE_BIN ||
    which(['claude']) ||
    [join(homedir(), '.local/bin', IS_WIN ? 'claude.exe' : 'claude'), join(homedir(), '.claude/local/claude')].find(existsSync)
  return bin ? launcher(bin) : null
}

function launcher(bin) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', bin], shell: true, label: bin }
  }
  return { cmd: bin, args: [], label: bin }
}

/** Runs a CLI to completion without blocking the server. */
function run(cli, args, { timeout = 20000 } = {}) {
  return new Promise((done) => {
    const child = spawn(cli.cmd, [...cli.args, ...args], {
      windowsHide: true,
      shell: cli.shell ?? false,
      env: { ...process.env, NO_COLOR: '1' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('error', () => {
      clearTimeout(timer)
      done({ code: -1, out: '', err: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, out: out.trim(), err: err.trim() })
    })
    child.stdin.end()
  })
}

let statusCache = { at: 0, value: null }
let statusRun = null

/** Which CLIs exist, their versions, sign-in state and models (cached 30 s). */
function cliStatus() {
  if (statusCache.value && Date.now() - statusCache.at < 30_000) return Promise.resolve(statusCache.value)
  statusRun ??= checkClis().finally(() => (statusRun = null))
  return statusRun
}

async function checkClis() {
  const claude = resolveClaude()
  const cursor = resolveCursor()
  const providers = {
    'claude-code': { installed: !!claude, models: CLAUDE_MODELS },
    cursor: { installed: !!cursor, models: ['auto'] },
  }
  const checkClaude = async () => {
    const [v, auth] = await Promise.all([run(claude, ['--version']), run(claude, ['auth', 'status'])])
    providers['claude-code'].version = v.out.split(/\s/)[0] || ''
    let json = null
    try {
      json = JSON.parse(auth.out)
    } catch {
      // older CLI: text output
    }
    providers['claude-code'].loggedIn = json ? json.loggedIn ?? json.authMethod !== 'none' : auth.code === 0
    providers['claude-code'].account = json?.email ?? json?.account?.email ?? ''
    providers['claude-code'].hint = 'Run: claude auth login'
  }
  const checkCursor = async () => {
    const [v, status, models] = await Promise.all([
      run(cursor, ['--version']),
      run(cursor, ['status'], { timeout: 25000 }),
      run(cursor, ['models'], { timeout: 25000 }),
    ])
    providers.cursor.version = v.out.split(/\s/)[0] || cursor.label.replace(/^cursor-agent /, '')
    const text = `${status.out}\n${status.err}`
    providers.cursor.loggedIn = status.code === 0 && !/not (logged|signed) in|login required/i.test(text)
    providers.cursor.account = /logged in as\s+(\S+)/i.exec(text)?.[1] ?? ''
    providers.cursor.hint = 'Run: cursor-agent login'
    const list = models.out
      .split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .map((l) => /^([\w.\-]+)(\s|$)/.exec(l)?.[1])
      .filter((m) => m && !/^(available|models?|current|default)$/i.test(m))
    if (list.length) providers.cursor.models = [...new Set(['auto', ...list])]
  }
  await Promise.all([claude && checkClaude(), cursor && checkCursor()])
  statusCache = { at: Date.now(), value: providers }
  return providers
}

/* ---------- prompts ---------- */

/** OpenAI messages → { system, prompt } for a one-shot CLI run. */
function flatten(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n\n')
  const turns = messages.filter((m) => m.role !== 'system')
  const last = turns.at(-1)
  const earlier = turns.slice(0, -1)
  let prompt = ''
  if (earlier.length) {
    prompt += '<conversation_so_far>\n'
    for (const m of earlier) prompt += `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${textOf(m.content)}\n\n`
    prompt += '</conversation_so_far>\n\nReply to the latest message:\n\n'
  }
  prompt += textOf(last?.content ?? '')
  return { system, prompt }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  return ''
}

/* ---------- running a chat ---------- */

let running = 0

/**
 * Spawns the CLI for MODEL ("claude-code/sonnet", "cursor/auto") and calls
 * ON(event) with { type: 'text' | 'reasoning' | 'tool', … }. Resolves when
 * the CLI exits. SIGNAL kills it.
 */
function runChat(model, messages, on, signal) {
  const [provider, ...rest] = model.split('/')
  const sub = rest.join('/') || ''
  if (sub && !MODEL_RE.test(sub)) return Promise.reject(httpError(400, `Bad model name: ${sub}`))
  const { system, prompt } = flatten(messages)
  const work = join(tmpdir(), `chromind-${randomUUID()}`)
  mkdirSync(work, { recursive: true })
  // Windows: the CLI can hold the folder for a moment after exiting. Never
  // let a failed delete take the server down; try again later instead.
  const cleanup = (attempt = 0) => {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
    } catch {
      if (attempt < 5) setTimeout(() => cleanup(attempt + 1), 15_000).unref()
    }
  }

  let cli
  let args
  let input = null
  let parse
  if (provider === 'claude-code') {
    cli = resolveClaude()
    if (!cli) return Promise.reject(httpError(503, 'Claude Code CLI not found. Install it: https://claude.com/claude-code'))
    writeFileSync(join(work, 'system.md'), system || 'You are a helpful assistant.')
    args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--system-prompt-file', join(work, 'system.md'),
      '--tools', '',
      '--disallowedTools', 'mcp__*',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      ...(sub ? ['--model', sub] : []),
    ]
    input = prompt
    parse = claudeParser(on)
  } else if (provider === 'cursor') {
    cli = resolveCursor()
    if (!cli) return Promise.reject(httpError(503, 'Cursor CLI not found. Install it: https://cursor.com/cli'))
    const full = `${system ? `<instructions>\n${system}\n</instructions>\n\n` : ''}${prompt}`
    let positional = full
    if (full.length > (IS_WIN ? 24000 : 100000)) {
      writeFileSync(join(work, 'request.md'), full)
      positional =
        'The full request is in the file request.md in the current workspace. Read it, then answer it directly. Do not mention the file.'
    }
    args = [
      '-p',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--mode', 'ask',
      '--trust',
      '--workspace', work,
      ...(sub && sub !== 'auto' ? ['--model', sub] : []),
      positional,
    ]
    parse = cursorParser(on)
  } else {
    return Promise.reject(httpError(404, `Unknown model ${model}. Use claude-code/<model> or cursor/<model>.`))
  }

  if (cli.shell && provider === 'cursor') {
    // A .cmd launcher would put the prompt through cmd.exe quoting: refuse.
    cleanup()
    return Promise.reject(httpError(500, 'Set CHROMIND_CURSOR_BIN to the cursor-agent node launcher.'))
  }
  if (running >= MAX_CONCURRENT) {
    cleanup()
    return Promise.reject(httpError(429, 'Bridge is busy, try again in a moment.'))
  }

  running++
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cli.cmd, [...cli.args, ...args], {
      cwd: work,
      windowsHide: true,
      shell: cli.shell ?? false,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    })
    let stderr = ''
    let buffer = ''
    let finished = false
    const finish = (err) => {
      if (finished) return
      finished = true
      running--
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      cleanup()
      err ? reject(err) : resolvePromise(parse.result())
    }
    const kill = () => {
      child.kill()
      finish(httpError(499, 'Stopped'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(httpError(504, `The CLI took longer than ${TIMEOUT_MS / 1000}s.`))
    }, TIMEOUT_MS)
    signal?.addEventListener('abort', kill)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) parse.line(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => (stderr += chunk).length > 8000 && (stderr = stderr.slice(-8000)))
    child.on('error', (err) => finish(httpError(500, `Could not start ${cli.label}: ${err.message}`)))
    child.on('close', (code) => {
      if (buffer.trim()) parse.line(buffer.trim())
      const failure = parse.error()
      if (failure) return finish(httpError(502, failure))
      if (code !== 0 && !parse.result().text) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`
        const hint = /log ?in|auth|unauthori[sz]ed|credential/i.test(detail)
          ? provider === 'cursor'
            ? ' Run: cursor-agent login'
            : ' Run: claude auth login'
          : ''
        return finish(httpError(502, `${provider === 'cursor' ? 'Cursor' : 'Claude Code'} failed: ${detail}.${hint}`))
      }
      finish()
    })
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Claude Code stream-json: stream_event deltas, then a result line. */
function claudeParser(on) {
  let text = ''
  let error = null
  let sawDelta = false
  return {
    line(line) {
      let json
      try {
        json = JSON.parse(line)
      } catch {
        return
      }
      if (json.type === 'stream_event') {
        const ev = json.event ?? {}
        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawDelta = true
            text += ev.delta.text
            on({ type: 'text', text: ev.delta.text })
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            on({ type: 'reasoning', text: ev.delta.thinking })
          }
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          on({ type: 'tool', name: ev.content_block.name })
        }
      } else if (json.type === 'assistant' && !sawDelta) {
        for (const block of json.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            text += block.text
            on({ type: 'text', text: block.text })
          }
        }
      } else if (json.type === 'result') {
        if (json.is_error) error = String(json.result || json.subtype || 'Claude Code reported an error')
        else if (!text && json.result) {
          text = json.result
          on({ type: 'text', text })
        }
      }
    },
    error: () => error,
    result: () => ({ text }),
  }
}

/**
 * Cursor stream-json with --stream-partial-output: assistant events with
 * timestamp_ms and no model_call_id are new text; the others repeat it.
 */
function cursorParser(on) {
  let text = ''
  let error = null
  return {
    line(line) {
      let json
      try {
        json = JSON.parse(line)
      } catch {
        return
      }
      if (json.type === 'thinking' && json.subtype === 'delta' && json.text) {
        on({ type: 'reasoning', text: json.text })
      } else if (json.type === 'assistant') {
        if (json.timestamp_ms == null || json.model_call_id) return
        for (const block of json.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            text += block.text
            on({ type: 'text', text: block.text })
          }
        }
      } else if (json.type === 'tool_call' && json.subtype === 'started') {
        const call = json.tool_call ?? {}
        const name = Object.keys(call)[0]?.replace(/ToolCall$/, '') || call.function?.name || 'tool'
        on({ type: 'tool', name })
      } else if (json.type === 'result') {
        if (json.is_error) error = String(json.result || 'Cursor reported an error')
        else if (!text && json.result) {
          text = json.result
          on({ type: 'text', text })
        }
      }
    },
    error: () => error,
    result: () => ({ text }),
  }
}

/* ---------- HTTP ---------- */

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors(res.req) })
  res.end(JSON.stringify(body))
}

function cors(req) {
  const origin = req.headers.origin || ''
  return /^(chrome|moz)-extension:\/\//.test(origin)
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        vary: 'origin',
      }
    : {}
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 8 * 1024 * 1024) {
        reject(httpError(413, 'Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(httpError(400, 'Body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function authorized(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const expected = getConfig().token
  if (token.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://bridge')
  const origin = req.headers.origin || ''
  // Web pages may not use the bridge (DNS rebinding, drive-by requests).
  if (/^https?:\/\//.test(origin)) return send(res, 403, { error: { message: 'Web pages may not use ChroMind Bridge.' } })
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req))
    return res.end()
  }
  if (url.pathname === '/health' || url.pathname === '/v1/health') {
    return send(res, 200, { ok: true, name: 'chromind-bridge', version: VERSION })
  }
  if (!authorized(req)) return send(res, 401, { error: { message: 'Missing or wrong bridge token.' } })

  if (req.method === 'GET' && url.pathname === '/v1/status') {
    return send(res, 200, { ok: true, version: VERSION, providers: await cliStatus() })
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const status = await cliStatus()
    const data = []
    for (const [id, p] of Object.entries(status)) {
      if (p.installed) for (const m of p.models) data.push({ id: `${id}/${m}`, object: 'model', owned_by: id })
    }
    return send(res, 200, { object: 'list', data })
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readBody(req)
    if (!Array.isArray(body.messages) || !body.messages.length) throw httpError(400, 'messages is required')
    const model = String(body.model || 'claude-code/sonnet')
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    if (!body.stream) {
      const { text } = await runChat(model, body.messages, () => {}, controller.signal)
      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      })
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...cors(req),
    })
    const chunk = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    chunk({ role: 'assistant' })
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 10_000)
    try {
      await runChat(
        model,
        body.messages,
        (ev) => {
          if (ev.type === 'text') chunk({ content: ev.text })
          else if (ev.type === 'reasoning') chunk({ reasoning_content: ev.text })
          else if (ev.type === 'tool') res.write(`event: chromind.tool\ndata: ${JSON.stringify({ name: ev.name })}\n\n`)
        },
        controller.signal,
      )
      chunk({}, 'stop')
    } catch (err) {
      if (err.status !== 499) res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`)
    } finally {
      clearInterval(keepalive)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    return
  }
  send(res, 404, { error: { message: `No route ${req.method} ${url.pathname}` } })
}

function serve() {
  const { token, port, host } = getConfig()
  const PORT = Number(process.env.CHROMIND_BRIDGE_PORT || port || 8765)
  const HOST = process.env.CHROMIND_BRIDGE_HOST || host || '127.0.0.1'
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end()
      send(res, err.status && err.status < 600 ? err.status : 500, { error: { message: err.message } })
    })
  })
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use. Is ChroMind Bridge already running? Set CHROMIND_BRIDGE_PORT to use another.`)
      process.exit(1)
    }
    throw err
  })
  server.listen(PORT, HOST, async () => {
    console.log(`\n  ChroMind Bridge ${VERSION} on http://${HOST}:${PORT}\n\n  Token: ${token}\n  Paste it in ChroMind → Settings → Bridge.\n\n  Checking the CLIs…`)
    const status = await cliStatus()
    const line = (name, p) =>
      `  ${name.padEnd(12)} ${p.installed ? `${p.version || 'found'}${p.loggedIn === false ? '  (not signed in: ' + p.hint + ')' : ''}` : 'not found'}`
    console.log(line('Claude Code', status['claude-code']))
    console.log(line('Cursor', status.cursor))
    console.log('\n  Ready. Leave this window open (or run "install" to start it with your computer).\n')
  })
}

/* ---------- autostart ---------- */

function install() {
  const script = fileURLToPath(import.meta.url)
  const node = process.execPath
  if (IS_WIN) {
    const startup = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup')
    const vbs = join(startup, 'ChroMind Bridge.vbs')
    const cmd = `"""${node}"" ""${script}"""`
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run ${cmd}, 0, False\r\n`)
    console.log(`Installed: ${vbs}\nIt starts hidden when you sign in. Starting it now…`)
    spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref()
  } else if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents/com.chromind.bridge.plist')
    mkdirSync(dirname(plist), { recursive: true })
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.chromind.bridge</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${join(CONFIG_DIR, 'bridge.log')}</string>
</dict></plist>
`,
    )
    spawnSync('launchctl', ['unload', plist])
    spawnSync('launchctl', ['load', plist])
    console.log(`Installed and started: ${plist}`)
  } else {
    const unit = join(homedir(), '.config/systemd/user/chromind-bridge.service')
    mkdirSync(dirname(unit), { recursive: true })
    writeFileSync(
      unit,
      `[Unit]
Description=ChroMind Bridge
After=network.target

[Service]
ExecStart=${node} ${script}
Environment=PATH=${process.env.PATH}
Restart=on-failure

[Install]
WantedBy=default.target
`,
    )
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    spawnSync('systemctl', ['--user', 'enable', '--now', 'chromind-bridge'], { stdio: 'inherit' })
    console.log(`Installed and started: ${unit}`)
  }
  console.log(`Token: ${getConfig().token}`)
}

function uninstall() {
  if (IS_WIN) {
    const vbs = join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/ChroMind Bridge.vbs')
    rmSync(vbs, { force: true })
    console.log('Removed the startup entry. Stop a running bridge from Task Manager (node.exe) or reboot.')
  } else if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents/com.chromind.bridge.plist')
    spawnSync('launchctl', ['unload', plist])
    rmSync(plist, { force: true })
    console.log('Removed and stopped.')
  } else {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'chromind-bridge'], { stdio: 'inherit' })
    rmSync(join(homedir(), '.config/systemd/user/chromind-bridge.service'), { force: true })
    console.log('Removed and stopped.')
  }
}

/* ---------- main ---------- */

const command = process.argv[2]
const isMain = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (command === 'token') console.log(getConfig().token)
  else if (command === 'install') install()
  else if (command === 'uninstall') uninstall()
  else if (command === 'status') cliStatus().then((s) => console.log(JSON.stringify(s, null, 2)))
  else if (command && command !== 'start') {
    console.log('Usage: node chromind-bridge.mjs [start|token|status|install|uninstall]')
    process.exit(1)
  } else serve()
}

export { claudeParser, cursorParser, flatten }
