/**
 * Selection toolbar: select text on any page and a small ChroMind bar
 * offers Explain / Summarize / Translate / Ask. Answers stream into a
 * floating card (from the background, port "inline"), with "Continue in
 * side panel" to keep chatting.
 *
 * Everything lives in a closed shadow root so the page's CSS can't touch
 * it and ours can't leak. Turned off per site from the bar's menu, or
 * entirely in settings.
 */
;(() => {
  if (globalThis.__chromindSelection) return
  globalThis.__chromindSelection = true

  const api = globalThis.browser ?? globalThis.chrome
  const md = globalThis.CMMarkdown
  const HOST = location.hostname
  const IS_FIREFOX = api.runtime.getURL('').startsWith('moz-extension:')
  let settings = { selectionToolbar: true, toolbarBlocklist: [], translateTo: 'English', theme: 'system', customActions: [] }

  api.storage.local.get('settings').then(({ settings: s }) => {
    if (s) settings = { ...settings, ...s }
  })
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      settings = { ...settings, ...changes.settings.newValue }
      if (!enabled()) hideBar()
      applyTheme()
    }
  })

  const enabled = () => settings.selectionToolbar !== false && !(settings.toolbarBlocklist ?? []).includes(HOST)

  /* ---------- shadow root ---------- */

  const ICONS = {
    logo: '<svg viewBox="0 0 128 128" width="16" height="16"><defs><linearGradient id="g" x1="8" y1="10" x2="118" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="#c4ffe9"/><stop offset=".45" stop-color="#3ee6b0"/><stop offset="1" stop-color="#19c3e6"/></linearGradient></defs><path d="M88.3 39.5A36 36 0 1 0 88.3 88.5" stroke="url(#g)" stroke-width="30" fill="none"/><path d="M100 36c1.6 15.5 7.2 21 22 22.5-14.8 1.5-20.4 7-22 22.5-1.6-15.5-7.2-21-22-22.5 14.8-1.5 20.4-7 22-22.5Z" fill="#e6fff6"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    panel: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  }

  const CSS = `
:host { all: initial; }
.root { --accent:#3ee6b0; --accent-2:#22d3ee; --accent-rgb:62,230,176; --accent-2-rgb:34,211,238; --ink:#032019;
  --grad:linear-gradient(135deg,#b9ffe4 0%,#3ee6b0 46%,#1ec8e6 100%);
  --bg:#0f1514; --card:#151c1b; --subtle:#1a2321; --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.13);
  --text:#e8f2ef; --muted:#87a19b; --hover:rgba(255,255,255,.05); --danger:#ff6b81; --glass:rgba(16,23,22,.86);
  --shadow:0 16px 48px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.04);
  --mono:"JetBrains Mono","Cascadia Code",ui-monospace,Consolas,monospace;
  font: 13px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--text); color-scheme: dark; }
.root.light { --accent:#0aa57a; --accent-2:#0891b2; --accent-rgb:10,165,122; --accent-2-rgb:8,145,178; --ink:#fff;
  --grad:linear-gradient(135deg,#12c595 0%,#0aa57a 46%,#0891b2 100%);
  --bg:#fff; --card:#fff; --subtle:#eef4f2; --border:rgba(10,40,32,.09); --border-strong:rgba(10,40,32,.15);
  --text:#0f201b; --muted:#566d67; --hover:rgba(10,40,32,.05); --danger:#d9354f; --glass:rgba(255,255,255,.92);
  --shadow:0 16px 40px rgba(20,45,38,.18), 0 0 0 1px rgba(10,40,32,.06); color-scheme: light; }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.bar { position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: 2px; padding: 4px;
  border-radius: 12px; background: var(--glass); border: 1px solid var(--border-strong); box-shadow: var(--shadow);
  backdrop-filter: blur(18px) saturate(1.3); -webkit-backdrop-filter: blur(18px) saturate(1.3);
  animation: pop .18s cubic-bezier(.16,1,.3,1); }
.bar .logo { display: inline-flex; padding: 0 5px 0 4px; }
.bar button { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px; border: 0; border-radius: 8px;
  background: transparent; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.bar button:hover { background: rgba(var(--accent-rgb), .14); color: var(--accent); }
.bar .icon { width: 28px; padding: 0; justify-content: center; color: var(--muted); }
.menu { position: fixed; z-index: 2147483647; min-width: 200px; max-height: 320px; overflow-y: auto; padding: 4px; border-radius: 12px;
  background: var(--card); border: 1px solid var(--border-strong); box-shadow: var(--shadow); animation: pop .18s cubic-bezier(.16,1,.3,1); }
.menu button { display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; text-align: left;
  font-size: 12.5px; cursor: pointer; }
.menu button:hover { background: rgba(var(--accent-rgb), .13); }
.menu .muted { color: var(--muted); }
.menu hr { border: 0; height: 1px; background: var(--border); margin: 4px; }
.card { position: fixed; z-index: 2147483647; width: min(400px, calc(100vw - 24px)); max-height: min(460px, calc(100vh - 24px));
  display: flex; flex-direction: column; border-radius: 16px; background: var(--card); border: 1px solid var(--border-strong);
  box-shadow: var(--shadow); overflow: hidden; animation: pop .22s cubic-bezier(.16,1,.3,1); }
.card-head { display: flex; align-items: center; gap: 8px; padding: 9px 8px 9px 12px; border-bottom: 1px solid var(--border);
  cursor: grab; user-select: none; background: linear-gradient(180deg, rgba(var(--accent-rgb),.06), transparent); }
.card-head:active { cursor: grabbing; }
.card-title { flex: 1; min-width: 0; font-weight: 650; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-title small { font-weight: 500; color: var(--muted); margin-left: 4px; }
.icon-btn { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 7px;
  background: transparent; color: var(--muted); cursor: pointer; }
.icon-btn:hover { background: var(--hover); color: var(--text); }
.quote { margin: 10px 12px 0; padding: 6px 10px; border-radius: 8px; background: var(--subtle); color: var(--muted);
  font-size: 12px; max-height: 54px; overflow: hidden; white-space: pre-wrap; }
.ask { display: flex; gap: 6px; padding: 10px 12px 0; }
.ask input { flex: 1; min-width: 0; height: 34px; padding: 0 11px; border-radius: 10px; border: 1px solid var(--border-strong);
  background: var(--subtle); color: var(--text); font: inherit; outline: none; }
.ask input:focus { border-color: rgba(var(--accent-rgb),.5); }
.ask button { width: 34px; height: 34px; border: 0; border-radius: 10px; background: var(--accent); color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; }
.body { flex: 1; min-height: 60px; overflow-y: auto; padding: 10px 14px 12px; }
.waiting { display: inline-flex; align-items: center; gap: 10px; padding: 6px 0; color: var(--muted); font-size: 12px; }
.waiting .cm-scanner { color: var(--accent); }
.error { color: var(--danger); font-size: 12.5px; }
.error a { color: var(--accent-2); }
.foot { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--border); }
.foot .btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border-strong);
  background: var(--subtle); font-size: 12px; font-weight: 600; cursor: pointer; }
.foot .btn:hover { border-color: rgba(var(--accent-rgb),.45); color: var(--accent); }
.foot .btn.primary { background: var(--accent); color: var(--ink); border-color: transparent; }
.continue-wrap { position: relative; display: inline-flex; }
.continue-wrap iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 8px;
  color-scheme: normal; visibility: hidden; }
.continue-wrap.framed iframe { visibility: visible; }
.md .cm-ts { display: inline-flex; padding: 0 6px; margin: 0 1px; border-radius: 6px; border: 1px solid rgba(var(--accent-rgb),.3);
  background: rgba(var(--accent-rgb),.1); color: var(--accent); font: 600 11.5px var(--mono); cursor: pointer; }
.foot .hint { flex: 1; text-align: right; font-size: 11px; color: var(--muted); padding-right: 4px; }
.md { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 .65em; } .md ul, .md ol { margin: 0 0 .7em; padding-left: 1.3em; } .md li { margin: .15em 0; }
.md li::marker { color: var(--accent); } .md h3, .md h4, .md h5, .md h6 { margin: .9em 0 .4em; font-size: 13.5px; }
.md code { font-family: var(--mono); font-size: .85em; padding: 1px 5px; border-radius: 5px; background: var(--subtle); }
.md pre { margin: 0; padding: 9px 11px; overflow-x: auto; } .md pre code { padding: 0; background: none; }
.md .cm-code { margin: 0 0 .7em; border: 1px solid var(--border-strong); border-radius: 9px; overflow: hidden; }
.md .cm-code-head { display: flex; justify-content: space-between; align-items: center; padding: 3px 6px 3px 10px; background: var(--subtle);
  font: 11px var(--mono); color: var(--muted); }
.md .cm-copy-code { border: 0; background: none; font-size: 11px; color: var(--muted); cursor: pointer; }
.md a { color: var(--accent-2); } .md blockquote { margin: 0 0 .7em; padding: 6px 10px; border-radius: 8px; background: var(--subtle); color: var(--muted); }
.md table { border-collapse: collapse; font-size: 12px; } .md th, .md td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.md .cm-table { overflow-x: auto; margin-bottom: .7em; }
@keyframes pop { from { opacity: 0; transform: translateY(4px) scale(.98); } }
@keyframes blink { 50% { opacity: 0; } }
@keyframes pulse { 0%,100% { transform: scale(.7); opacity: .5; } 50% { transform: scale(1); opacity: 1; } }
`

  let hostEl = null
  let shadow = null
  let rootEl = null
  let bar = null
  let menu = null
  let card = null
  let lastSelection = { text: '', rect: null }

  function ensureRoot() {
    if (hostEl?.isConnected) return
    hostEl = document.createElement('chromind-ui')
    hostEl.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;'
    shadow = hostEl.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = CSS
    rootEl = document.createElement('div')
    rootEl.className = 'root'
    shadow.append(style, rootEl)
    document.documentElement.append(hostEl)
    applyTheme()
  }

  function applyTheme() {
    if (!rootEl) return
    const light =
      settings.theme === 'light' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches)
    rootEl.classList.toggle('light', light)
  }

  const ownsEvent = (e) => hostEl && e.composedPath().includes(hostEl)

  /* ---------- the bar ---------- */

  function selectionInfo() {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null
    const text = sel.toString().trim()
    if (text.length < 2) return null
    const active = document.activeElement
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return null
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect.width && !rect.height) return null
    return { text, rect }
  }

  function showBar(info) {
    ensureRoot()
    hideMenu()
    lastSelection = info
    if (!bar) {
      bar = document.createElement('div')
      bar.className = 'bar'
      bar.setAttribute('role', 'toolbar')
      bar.innerHTML = `<span class="logo" title="ChroMind">${ICONS.logo}</span>
        <button type="button" data-action="explain">Explain</button>
        <button type="button" data-action="summarize">Summarize</button>
        <button type="button" data-action="translate">Translate</button>
        <button type="button" data-ask>Ask</button>
        <button type="button" class="icon" data-more title="More">${ICONS.more}</button>`
      bar.addEventListener('mousedown', (e) => e.preventDefault())
      bar.addEventListener('click', onBarClick)
    }
    rootEl.append(bar)
    const { rect } = info
    const w = bar.offsetWidth || 300
    const h = bar.offsetHeight || 36
    let top = rect.top - h - 8
    if (top < 8) top = rect.bottom + 8
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8))
    bar.style.top = `${Math.min(top, innerHeight - h - 8)}px`
    bar.style.left = `${left}px`
  }

  function hideBar() {
    bar?.remove()
    hideMenu()
  }

  function hideMenu() {
    menu?.remove()
    menu = null
  }

  function onBarClick(e) {
    const btn = e.target.closest('button')
    if (!btn) return
    if (btn.dataset.more !== undefined) return toggleMenu(btn)
    const text = lastSelection.text
    hideBar()
    if (btn.dataset.ask !== undefined) openCard({ ask: true, text })
    else openCard({ actionId: btn.dataset.action, title: btn.textContent.trim(), text })
  }

  function toggleMenu(anchor) {
    if (menu) return hideMenu()
    menu = document.createElement('div')
    menu.className = 'menu'
    const custom = (settings.customActions ?? []).filter((a) => a.title && a.prompt && (a.scopes ?? ['selection']).includes('selection'))
    menu.innerHTML = [
      ['simplify', 'Simplify'],
      ['improve', 'Improve writing'],
      ['factcheck', 'Fact-check'],
      ['reply', 'Draft a reply'],
      ['eli5', "Explain like I'm 5"],
      ...custom.map((a) => [a.id, a.title]),
    ]
      .map(([id, title]) => `<button type="button" data-action="${id}">${md.escape(title)}</button>`)
      .join('') +
      `<hr><button type="button" class="muted" data-hide-site>Hide on ${md.escape(HOST)}</button>
       <button type="button" class="muted" data-off>Turn off the toolbar</button>`
    menu.addEventListener('mousedown', (e) => e.preventDefault())
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('button')
      if (!btn) return
      const text = lastSelection.text
      if (btn.dataset.hideSite !== undefined || btn.dataset.off !== undefined) {
        hideBar()
        const { settings: stored = {} } = await api.storage.local.get('settings')
        const next =
          btn.dataset.off !== undefined
            ? { ...stored, selectionToolbar: false }
            : { ...stored, toolbarBlocklist: [...new Set([...(stored.toolbarBlocklist ?? []), HOST])] }
        await api.storage.local.set({ settings: next })
        return
      }
      hideBar()
      openCard({ actionId: btn.dataset.action, title: btn.textContent.trim(), text })
    })
    rootEl.append(menu)
    const r = anchor.getBoundingClientRect()
    const below = r.bottom + 6 + menu.offsetHeight < innerHeight
    menu.style.top = `${below ? r.bottom + 6 : r.top - menu.offsetHeight - 6}px`
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`
  }

  /* ---------- the answer card ---------- */

  function placeCard(el) {
    const rect = lastSelection.rect
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = rect ? rect.bottom + 10 : 80
    if (top + h > innerHeight - 12) top = rect ? Math.max(12, rect.top - h - 10) : 12
    if (top + h > innerHeight - 12) top = Math.max(12, innerHeight - h - 12)
    const left = rect ? Math.max(12, Math.min(rect.left, innerWidth - w - 12)) : innerWidth - w - 24
    el.style.top = `${top}px`
    el.style.left = `${left}px`
  }

  /** The card grows as the answer streams: slide it up so it stays visible. */
  function keepOnScreen() {
    if (!card || card._dragged) return
    const r = card.getBoundingClientRect()
    if (r.bottom > innerHeight - 12) card.style.top = `${Math.max(12, innerHeight - 12 - r.height)}px`
  }

  function closeCard() {
    card?._cleanup?.()
    card?._port?.disconnect()
    card?.remove()
    card = null
  }

  function openCard({ actionId = null, title = 'Ask', text, ask = false }) {
    ensureRoot()
    closeCard()
    card = document.createElement('div')
    card.className = 'card'
    card.innerHTML = `<div class="card-head"><span>${ICONS.logo}</span><div class="card-title">${md.escape(title)}<small></small></div>
        <button type="button" class="icon-btn" data-close title="Close (Esc)">${ICONS.close}</button></div>
      <div class="quote"></div>
      ${ask ? `<form class="ask"><input type="text" placeholder="Ask about the selection…" aria-label="Question"><button type="submit" title="Ask">${ICONS.send}</button></form>` : ''}
      <div class="body" ${ask ? 'hidden' : ''}><div class="md"></div></div>
      <div class="foot" hidden><button type="button" class="btn" data-copy>${ICONS.copy}Copy</button>
        <span class="continue-wrap"><button type="button" class="btn primary" data-continue>${ICONS.panel}Continue in side panel</button></span><span class="hint"></span></div>`
    card.querySelector('.quote').textContent = text.length > 280 ? text.slice(0, 280) + '…' : text
    rootEl.append(card)
    placeCard(card)
    dragHandle(card, card.querySelector('.card-head'))
    card.querySelector('[data-close]').addEventListener('click', closeCard)
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCard()
      e.stopPropagation()
    })
    if (ask) {
      const form = card.querySelector('.ask')
      const input = form.querySelector('input')
      setTimeout(() => input.focus(), 0)
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const question = input.value.trim()
        if (!question) return
        form.remove()
        card.querySelector('.card-title').firstChild.textContent = question.length > 48 ? question.slice(0, 48) + '…' : question
        run({ question, text })
      })
    } else {
      run({ actionId, text })
    }
  }

  /** The YouTube video playing on this page, if any. */
  const pageVideo = () => (/^\/(watch|shorts\/|live\/)/.test(location.pathname) ? md.youTube(location.href)?.id : null)

  function seekHere(seconds) {
    const video = document.querySelector('video')
    if (!video) return false
    video.currentTime = seconds
    video.play?.()
    return true
  }

  /** Timestamps and links to this page's video seek it instead of opening a new tab. */
  function onAnswerClick(e) {
    const ts = e.target.closest('.cm-ts')
    if (ts) return seekHere(Number(ts.dataset.seconds))
    const link = e.target.closest('a[data-yt]')
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || link.dataset.yt !== pageVideo()) return
    e.preventDefault()
    if (link.dataset.seconds) seekHere(Number(link.dataset.seconds))
  }

  /**
   * Firefox only opens the sidebar from the extension's own UI, so there the
   * button is an extension frame (content/continue.html) laid over ours. Ours
   * stays as the fallback if the page blocks the frame.
   */
  function frameContinue(wrap, threadId) {
    const frame = document.createElement('iframe')
    const theme = rootEl.classList.contains('light') ? 'light' : 'dark'
    frame.src = api.runtime.getURL(`content/continue.html?thread=${encodeURIComponent(threadId)}&theme=${theme}`)
    frame.title = 'Continue in side panel'
    const onMessage = (e) => {
      if (e.source !== frame.contentWindow) return
      if (e.data?.chromind === 'continue-ready') wrap.classList.add('framed')
      if (e.data?.chromind === 'continued' && e.data.ok) closeCard()
    }
    addEventListener('message', onMessage)
    card._cleanup = () => removeEventListener('message', onMessage)
    wrap.append(frame)
  }

  function run({ actionId, question, text }) {
    const body = card.querySelector('.body')
    const out = card.querySelector('.md')
    const foot = card.querySelector('.foot')
    const sub = card.querySelector('.card-title small')
    const opts = { timestamps: !!pageVideo() }
    out.addEventListener('click', onAnswerClick)
    body.hidden = false
    out.innerHTML = '<div class="waiting"><span class="waiting-label">Working</span></div>'
    out.querySelector('.waiting').prepend(globalThis.CMScanner.create({ size: 5, gap: 2 }))
    card.classList.add('streaming')
    let answer = ''
    let threadId = null
    let frame = 0
    const paint = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        // Keep the reader at the top of a short answer; only follow the
        // stream if they scrolled down to the end themselves.
        const following = body.scrollTop > 0 && body.scrollHeight - body.scrollTop - body.clientHeight < 40
        out.innerHTML = md.render(answer, opts)
        if (following) body.scrollTop = body.scrollHeight
        keepOnScreen()
      })
    }
    const port = api.runtime.connect({ name: 'inline' })
    card._port = port
    port.onMessage.addListener((msg) => {
      const label = out.querySelector('.waiting-label')
      if (msg.type === 'start') sub.textContent = `· ${msg.provider}`
      else if (msg.type === 'reasoning' && label) label.textContent = 'Thinking'
      else if (msg.type === 'tool' && label) label.textContent = `Using ${msg.name}`
      else if (msg.type === 'text') {
        answer += msg.text
        paint()
      } else if (msg.type === 'done') {
        card.classList.remove('streaming')
        threadId = msg.threadId
        out.innerHTML = md.render(answer, opts)
        foot.hidden = false
        keepOnScreen()
        foot.querySelector('[data-continue]').hidden = !threadId
        if (threadId && IS_FIREFOX) frameContinue(foot.querySelector('.continue-wrap'), threadId)
      } else if (msg.type === 'error') {
        card.classList.remove('streaming')
        const err = msg.error
        out.innerHTML = `<p class="error">${md.escape(err.message)}${err.link ? ` <a href="${md.escape(err.link)}" target="_blank" rel="noopener">${md.escape(err.linkLabel || 'Open')}</a>` : ''}</p>`
        if (err.action) {
          const link = document.createElement('a')
          link.href = '#'
          link.textContent = ' Open settings'
          link.addEventListener('click', (e) => {
            e.preventDefault()
            api.runtime.sendMessage({ type: 'open-options', section: err.action === 'settings:bridge' ? 'bridge' : 'providers' })
          })
          out.querySelector('.error').append(link)
        }
      }
    })
    port.postMessage({ type: 'run', actionId, question, selection: text, title: document.title, url: location.href })

    foot.querySelector('[data-copy]').onclick = async () => {
      await navigator.clipboard.writeText(answer)
      foot.querySelector('.hint').textContent = 'Copied'
    }
    foot.querySelector('[data-continue]').onclick = async () => {
      const res = await api.runtime.sendMessage({ type: 'open-thread', threadId }).catch(() => null)
      if (res?.opened) closeCard()
      else foot.querySelector('.hint').textContent = 'Could not open the panel. Try Alt+Shift+A.'
    }
  }

  function dragHandle(el, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return
      const startX = e.clientX - el.offsetLeft
      const startY = e.clientY - el.offsetTop
      handle.setPointerCapture(e.pointerId)
      const move = (ev) => {
        el._dragged = true
        el.style.left = `${Math.max(0, Math.min(ev.clientX - startX, innerWidth - 60))}px`
        el.style.top = `${Math.max(0, Math.min(ev.clientY - startY, innerHeight - 40))}px`
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    })
  }

  /* ---------- page events ---------- */

  let pending = 0
  function maybeShow(e) {
    if (!enabled() || ownsEvent(e)) return
    clearTimeout(pending)
    pending = setTimeout(() => {
      const info = selectionInfo()
      if (info) showBar(info)
      else hideBar()
    }, 10)
  }

  document.addEventListener('mouseup', maybeShow, true)
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.shiftKey || e.key === 'Shift') maybeShow(e)
    },
    true,
  )
  document.addEventListener(
    'mousedown',
    (e) => {
      if (ownsEvent(e)) return
      hideBar()
    },
    true,
  )
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        hideBar()
        closeCard()
      }
    },
    true,
  )
  addEventListener('scroll', () => hideBar(), { passive: true, capture: true })
})()
