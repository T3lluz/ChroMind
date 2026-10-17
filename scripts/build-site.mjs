/**
 * Builds the docs site into dist/site/ (deployed to GitHub Pages by
 * .github/workflows/pages.yml):
 *
 *   site/index.html          landing page
 *   site/pages/*.html        docs pages: a front-matter comment, then HTML
 *   site/assets/             CSS, JS, icons, screenshots
 *   dist/chromind-*          packages from scripts/pack.mjs, when present
 *
 * Pretty URLs (docs/install/), relative links ({{root}}), a generated
 * sidebar, "On this page" table of contents and previous/next links.
 *
 *   node scripts/build-site.mjs            build
 *   node scripts/build-site.mjs --serve    build, serve on :4173, rebuild per request
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { chromeManifest, distDir, root } from './extension-files.mjs'

const siteDir = resolve(root, 'site')
const outDir = resolve(distDir, 'site')
const GROUPS = ['Start here', 'Using ChroMind', 'Connect', 'Reference']
const REPO = 'https://github.com/T3lluz/ChroMind'

function parsePage(file) {
  const raw = readFileSync(join(siteDir, 'pages', file), 'utf8')
  const match = /^<!--([\s\S]*?)-->\s*/.exec(raw)
  const meta = {}
  for (const line of (match?.[1] ?? '').split('\n')) {
    const m = /^\s*(\w+):\s*(.*?)\s*$/.exec(line)
    if (m) meta[m[1]] = m[2]
  }
  const slug = meta.slug ?? file.replace(/\.html$/, '')
  return {
    slug,
    title: meta.title ?? slug,
    nav: meta.nav ?? meta.title ?? slug,
    group: meta.group ?? 'Reference',
    blurb: meta.blurb ?? '',
    order: Number(meta.order ?? 99),
    body: raw.slice(match ? match[0].length : 0),
  }
}

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&\w+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Gives every <h2> an id and returns the TOC entries. */
function withAnchors(body) {
  const toc = []
  const html = body.replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/g, (all, attrs = '', inner) => {
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? slugify(inner)
    toc.push({ id, text: inner.replace(/<[^>]+>/g, '') })
    const clean = attrs.replace(/\s*id="[^"]*"/, '')
    return `<h2 id="${id}"${clean}><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h2>`
  })
  return { html, toc }
}

function shell({ title, description, rootPath, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="theme-color" content="#0b0f0f">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${rootPath}assets/icon-512.png">
<link rel="icon" href="${rootPath}assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${rootPath}assets/apple-touch-icon.png">
<link rel="stylesheet" href="${rootPath}assets/site.css">
<script>try{var t=localStorage.getItem('chromind-theme');document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch(e){document.documentElement.dataset.theme='dark'}</script>
<script defer src="${rootPath}assets/site.js"></script>
</head>
<body class="${bodyClass}" data-root="${rootPath}">
${body}
</body>
</html>
`
}

function header(rootPath, crumb = '') {
  return `<header class="site-header">
  <div class="frost" aria-hidden="true"><div class="frost-dots"></div><div class="frost-glass"></div></div>
  <div class="site-header-inner">
    <a class="logo" href="${rootPath}"><img src="${rootPath}assets/icon.svg" width="28" height="28" alt=""><span>ChroMind</span></a>
    ${crumb ? `<span class="crumb">/ ${crumb}</span>` : ''}
    <nav class="top-links">
      <a href="${rootPath}docs/">Docs</a>
      <a href="${rootPath}docs/install/">Install</a>
      <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
      <button type="button" class="theme-btn" data-theme-toggle aria-label="Toggle theme"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg></button>
    </nav>
  </div>
</header>`
}

function footer(rootPath, version) {
  return `<footer class="site-footer">
  <div class="site-footer-inner">
    <span><img src="${rootPath}assets/icon.svg" width="18" height="18" alt=""> ChroMind v${version} · MIT</span>
    <span><a href="${REPO}" target="_blank" rel="noopener">Source</a> · <a href="${rootPath}docs/privacy/">Privacy</a> · <a href="${rootPath}docs/changelog/">Changelog</a> · Sibling of <a href="https://github.com/T3lluz/ChroMods" target="_blank" rel="noopener">ChroMods</a></span>
  </div>
</footer>`
}

function sideNav(pages, current, rootPath) {
  return GROUPS.map((group) => {
    const items = pages.filter((p) => p.group === group)
    if (!items.length) return ''
    return `<div class="nav-group"><p>${group}</p><ul>${items
      .map(
        (p) =>
          `<li><a href="${rootPath}docs/${p.slug === 'index' ? '' : p.slug + '/'}"${p.slug === current.slug ? ' aria-current="page"' : ''}>${p.nav}</a></li>`,
      )
      .join('')}</ul></div>`
  }).join('')
}

function docsPage(page, pages, version) {
  const rootPath = page.slug === 'index' ? '../' : '../../'
  const { html, toc } = withAnchors(page.body.replaceAll('{{root}}', rootPath).replaceAll('{{version}}', version))
  const i = pages.indexOf(page)
  const prev = pages[i - 1]
  const next = pages[i + 1]
  const link = (p) => `${rootPath}docs/${p.slug === 'index' ? '' : p.slug + '/'}`
  const body = `${header(rootPath, 'Docs')}
<div class="docs">
  <button type="button" class="nav-toggle" data-nav-toggle aria-expanded="false"><span>${page.group}</span> / <strong>${page.nav}</strong>
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
  <aside class="docs-nav" data-nav>${sideNav(pages, page, rootPath)}</aside>
  <main class="docs-main">
    <article class="prose">
      <p class="eyebrow">${page.group}</p>
      <h1>${page.title}</h1>
      ${page.blurb ? `<p class="lead">${page.blurb}</p>` : ''}
      ${html}
      <nav class="prev-next">
        ${prev ? `<a href="${link(prev)}"><small>Previous</small><strong>${prev.nav}</strong></a>` : '<span></span>'}
        ${next ? `<a class="next" href="${link(next)}"><small>Next</small><strong>${next.nav}</strong></a>` : ''}
      </nav>
      <p class="edit"><a href="${REPO}/edit/main/site/pages/${page.slug}.html" target="_blank" rel="noopener">Edit this page on GitHub</a></p>
    </article>
  </main>
  <aside class="toc">${toc.length > 1 ? `<p>On this page</p><ul>${toc.map((t) => `<li><a href="#${t.id}">${t.text}</a></li>`).join('')}</ul>` : ''}</aside>
</div>
${footer(rootPath, version)}`
  return shell({
    title: page.slug === 'index' ? 'ChroMind docs' : `${page.nav} · ChroMind docs`,
    description: page.blurb || 'ChroMind documentation',
    rootPath,
    body,
    bodyClass: 'is-docs',
  })
}

export function build() {
  const { version } = chromeManifest()
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  cpSync(resolve(siteDir, 'assets'), resolve(outDir, 'assets'), { recursive: true })
  copyFileSync(resolve(root, 'extension/icons/icon.svg'), resolve(outDir, 'assets/icon.svg'))
  // One theme for the extension and the site.
  copyFileSync(resolve(root, 'extension/styles/theme.css'), resolve(outDir, 'assets/theme.css'))

  const pages = readdirSync(resolve(siteDir, 'pages'))
    .filter((f) => f.endsWith('.html'))
    .map(parsePage)
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order)

  for (const page of pages) {
    const dir = page.slug === 'index' ? resolve(outDir, 'docs') : resolve(outDir, 'docs', page.slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'index.html'), docsPage(page, pages, version))
  }

  const landing = readFileSync(resolve(siteDir, 'index.html'), 'utf8').replaceAll('{{root}}', './').replaceAll('{{version}}', version)
  writeFileSync(
    resolve(outDir, 'index.html'),
    shell({
      title: 'ChroMind · AI side panel for Firefox and Chromium',
      description:
        'Ask, summarize and explain any page with your Claude and Cursor logins, or your own Hermes Agent server. Free and open source.',
      rootPath: './',
      body: `${header('./')}\n${landing}\n${footer('./', version)}`,
      bodyClass: 'is-landing',
    }),
  )
  writeFileSync(
    resolve(outDir, '404.html'),
    shell({
      title: 'Not found · ChroMind',
      description: 'Page not found',
      rootPath: '/ChroMind/',
      body: `${header('/ChroMind/')}<main class="not-found"><h1>Nothing here.</h1><p><a class="btn primary" href="/ChroMind/">Back to ChroMind</a></p></main>`,
    }),
  )
  writeFileSync(resolve(outDir, '.nojekyll'), '')

  for (const file of [
    'chromind-chrome.zip',
    'chromind-chrome.json',
    'chromind-firefox.xpi',
    'chromind-firefox-unsigned.xpi',
    'chromind-firefox.json',
    'chromind-firefox-updates.json',
    'chromind-bridge.mjs',
  ]) {
    const src = resolve(distDir, file)
    if (existsSync(src)) copyFileSync(src, resolve(outDir, file))
  }
  console.log(`OK: dist/site (${pages.length} docs pages, v${version})`)
}

function serve() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.xpi': 'application/x-xpinstall',
  }
  createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ChroMind/, '')
    if (path.endsWith('/') || path === '') {
      build()
      path += 'index.html'
    }
    const file = resolve(outDir, '.' + path)
    if (!file.startsWith(outDir) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end(readFileSync(resolve(outDir, '404.html')))
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  }).listen(4173, () => console.log('Docs: http://localhost:4173/ChroMind/'))
}

build()
if (process.argv.includes('--serve')) serve()
