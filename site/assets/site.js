/* ChroMind docs: theme, mobile nav, copy buttons, browser tabs, live package info. */
;(() => {
  const root = document.body.dataset.root || './'
  const ua = navigator.userAgent
  // Firefox and its forks (Zen, LibreWolf, Floorp, Waterfox) all say Firefox.
  const browser = /\bFirefox\//.test(ua) ? 'firefox' : 'chrome'

  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, v)
      } catch {
        /* private mode */
      }
    },
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      store.set('chromind-theme', next)
    }),
  )

  const navToggle = document.querySelector('[data-nav-toggle]')
  const nav = document.querySelector('[data-nav]')
  navToggle?.addEventListener('click', () => {
    const open = !nav.classList.contains('is-open')
    nav.classList.toggle('is-open', open)
    navToggle.setAttribute('aria-expanded', String(open))
  })

  document.querySelectorAll('.prose pre').forEach((pre) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copy-btn'
    btn.textContent = 'Copy'
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText)
        btn.textContent = 'Copied'
      } catch {
        btn.textContent = 'Select and copy'
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500)
    })
    pre.append(btn)
  })

  document.querySelectorAll('[data-tabs]').forEach((tabs) => {
    const buttons = [...tabs.querySelectorAll('[role="tab"]')]
    const panels = [...tabs.querySelectorAll('[role="tabpanel"]')]
    const select = (id) => {
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)))
      panels.forEach((p) => (p.hidden = p.dataset.panel !== id))
    }
    buttons.forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)))
    const fromHash = buttons.find((b) => location.hash === `#${b.dataset.tab}`)
    select(fromHash?.dataset.tab ?? (buttons.some((b) => b.dataset.tab === browser) ? browser : buttons[0]?.dataset.tab))
  })

  document.querySelectorAll('[data-browser-only]').forEach((el) => {
    el.hidden = el.dataset.browserOnly !== browser
  })

  // Table of contents: highlight the section in view.
  const links = [...document.querySelectorAll('.toc a')]
  if (links.length && 'IntersectionObserver' in window) {
    const spy = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (!visible[0]) return
        links.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${visible[0].target.id}`))
      },
      { rootMargin: '-80px 0px -65% 0px' },
    )
    document.querySelectorAll('.prose h2[id]').forEach((h) => spy.observe(h))
  }

  // Package info from the deploy (scripts/pack.mjs, scripts/sign-firefox.mjs).
  const getJSON = (name) =>
    fetch(`${root}${name}`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)

  // Set by the extension's content script (extension/content/site.js) when
  // ChroMind is installed in this browser.
  const installed = document.documentElement.dataset.chromindVersion || ''

  Promise.all([getJSON('chromind-firefox.json'), getJSON('chromind-chrome.json')]).then(([firefox, chrome]) => {
    let firefoxHref = null
    let chromeHref = null
    if (firefox) {
      const v = `?v=${encodeURIComponent(firefox.version)}`
      const signed = firefox.xpi ? `${root}${firefox.xpi}${v}` : null
      const unsigned = `${root}${firefox.unsigned}${v}`
      firefoxHref = signed ?? unsigned
      document.querySelectorAll('[data-firefox-install]').forEach((a) => (a.href = firefoxHref))
      document.querySelectorAll('[data-firefox-unsigned]').forEach((a) => (a.href = unsigned))
      document.querySelectorAll('[data-firefox-signed-only]').forEach((el) => (el.hidden = !signed))
      document.querySelectorAll('[data-firefox-unsigned-note]').forEach((el) => (el.hidden = !!signed))
      document.querySelectorAll('[data-version="firefox"]').forEach((el) => (el.textContent = `v${firefox.version}`))
    }
    if (chrome) {
      chromeHref = `${root}${chrome.zip}?v=${encodeURIComponent(chrome.version + '-' + chrome.fingerprint.slice(0, 10))}`
      document.querySelectorAll('[data-chrome-zip]').forEach((a) => (a.href = chromeHref))
      document.querySelectorAll('[data-version="chrome"]').forEach((el) => (el.textContent = `v${chrome.version}`))
    }
    if (installed) {
      const latest = browser === 'firefox' ? firefox : chrome
      const href = browser === 'firefox' ? firefoxHref : chromeHref
      document.querySelectorAll('[data-install-status]').forEach((box) =>
        showInstallStatus(box, latest && newer(latest.version, installed) ? { version: latest.version, href, signed: !!firefox?.xpi } : null),
      )
    }
  })

  /** True when version A is newer than B (x.y.z). */
  function newer(a, b) {
    const pa = String(a).split('.').map(Number)
    const pb = String(b).split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d > 0
    }
    return false
  }

  /** "Installed" or, with UPDATE, "Update available" plus its download. */
  function showInstallStatus(box, update) {
    const title = document.createElement('strong')
    const note = document.createElement('small')
    const copy = document.createElement('div')
    copy.className = 'status-copy'
    copy.append(title, note)
    box.replaceChildren(copy)
    box.classList.toggle('update', !!update)
    if (!update) {
      title.textContent = `ChroMind v${installed} is installed in this browser.`
      note.textContent = "You're up to date. Open it with Alt+Shift+A or the toolbar button."
    } else {
      title.textContent = `Update available: v${update.version}`
      note.textContent =
        browser === 'firefox'
          ? update.signed
            ? `You have v${installed}. Firefox installs it on its own within a day; to get it now, install it over this one.`
            : `You have v${installed}. Load the new build the same way you loaded this one.`
          : `You have v${installed}. Unzip it over the same folder, then press the reload arrow on ChroMind's card in chrome://extensions.`
      if (update.href) {
        const a = document.createElement('a')
        a.className = 'btn primary'
        a.href = update.href
        if (browser !== 'firefox') a.download = ''
        a.textContent = browser === 'firefox' ? `Install v${update.version}` : `Download v${update.version}`
        box.append(a)
      }
    }
    box.hidden = false
  }

  // The landing page's main button follows the visitor's browser.
  document.querySelectorAll('[data-primary-cta]').forEach((a) => {
    const label = a.querySelector('[data-label]')
    if (browser === 'firefox') {
      a.href = `${root}docs/install/#firefox`
      if (label) label.textContent = 'Add to Firefox'
    } else {
      a.href = `${root}docs/install/#chrome`
      if (label) label.textContent = 'Add to Chrome'
    }
  })
})()
