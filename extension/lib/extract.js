/**
 * Reading pages for context: the active tab (article text via Mozilla
 * Readability, YouTube transcripts), other tabs, links and images.
 * Runs in extension pages (side panel, background); the in-page parts are
 * self-contained functions handed to scripting.executeScript.
 */
import { api } from './browser.js'

const READABLE = /^(https?|file):/

export function canRead(url = '') {
  if (!READABLE.test(url)) return false
  // Stores block extension scripts.
  return !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)/.test(url)
}

export function isYouTubeWatch(url = '') {
  return /^https:\/\/(www\.|m\.)?youtube\.com\/(watch|shorts\/|live\/)/.test(url)
}

/**
 * Reads TAB and returns a context object:
 * { kind, title, url, text, chars, truncated, selection, siteName }.
 */
export async function readTab(tab, { maxChars = 60000 } = {}) {
  if (!canRead(tab?.url)) {
    throw new Error(tab?.url ? "ChroMind can't read this kind of page." : 'No page to read.')
  }
  const target = { tabId: tab.id }
  if (isYouTubeWatch(tab.url)) {
    const [{ result }] = await api.scripting.executeScript({ target, func: readYouTube, args: [maxChars] })
    if (result?.text) return { ...result, kind: 'youtube', url: tab.url }
  }
  await api.scripting.executeScript({ target, files: ['vendor/Readability.js'] }).catch(() => {})
  const [{ result }] = await api.scripting.executeScript({ target, func: readPage, args: [maxChars] })
  return { ...result, kind: 'page', url: tab.url }
}

/** Just the selected text in TAB (empty string when none). */
export async function readSelection(tab) {
  if (!canRead(tab?.url)) return ''
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => String(getSelection?.() ?? '').trim(),
    })
    return results.map((r) => r.result).find(Boolean) ?? ''
  } catch {
    return ''
  }
}

/** Seeks the YouTube player in TAB to SECONDS. */
export function seekVideo(tabId, seconds) {
  return api.scripting.executeScript({
    target: { tabId },
    func: (t) => {
      const video = document.querySelector('video')
      if (video) {
        video.currentTime = t
        video.play?.()
      }
    },
    args: [seconds],
  })
}

/** Fetches URL and turns it into readable text (needs a DOM: side panel only). */
export async function readLink(url, { maxChars = 60000 } = {}) {
  const res = await fetch(url, { credentials: 'include', redirect: 'follow' })
  if (!res.ok) throw new Error(`Could not open the link (${res.status}).`)
  const type = res.headers.get('content-type') || ''
  if (!/html|xml|text/.test(type)) throw new Error('That link is not a web page ChroMind can read.')
  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const base = doc.createElement('base')
  base.href = res.url || url
  doc.head?.prepend(base)
  let title = doc.title
  let text = ''
  if (globalThis.Readability) {
    try {
      const article = new globalThis.Readability(doc.cloneNode(true)).parse()
      if (article?.textContent?.trim().length > 200) {
        title = article.title || title
        text = article.textContent
      }
    } catch {
      // fall through to body text
    }
  }
  if (!text) {
    doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside').forEach((el) => el.remove())
    text = doc.body?.textContent ?? ''
  }
  text = tidy(text)
  return { kind: 'link', title: title || url, url: res.url || url, ...clip(text, maxChars) }
}

/** Fetches an image URL and returns a downscaled JPEG data URL. */
export async function imageToDataUrl(src, maxSide = 1568) {
  const res = await fetch(src, { credentials: 'include' })
  if (!res.ok) throw new Error(`Could not load the image (${res.status}).`)
  return downscale(await res.blob(), maxSide)
}

export async function downscale(blob, maxSide = 1568) {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(out)
  })
}

/** A screenshot of the visible part of the active tab in WINDOWID. */
export async function captureVisible(windowId) {
  const dataUrl = await api.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 })
  const blob = await (await fetch(dataUrl)).blob()
  return downscale(blob)
}

export function tidy(text) {
  return String(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function clip(text, maxChars) {
  const truncated = text.length > maxChars
  const out = truncated ? text.slice(0, maxChars) : text
  return { text: out, chars: text.length, truncated }
}

/* ---------- functions below run inside the page ---------- */

/** Article text (Readability when it finds an article), else visible body text. */
function readPage(maxChars) {
  const tidyText = (t) =>
    String(t)
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  const selection = String(getSelection?.() ?? '').trim()
  let title = document.title
  let text = ''
  let byline = ''
  let siteName = ''
  try {
    if (typeof Readability === 'function') {
      const article = new Readability(document.cloneNode(true), { charThreshold: 400 }).parse()
      if (article?.textContent && article.textContent.trim().length > 400) {
        title = article.title || title
        text = article.textContent
        byline = article.byline || ''
        siteName = article.siteName || ''
      }
    }
  } catch {
    // Readability can throw on unusual documents; use body text instead.
  }
  if (!text) {
    const root = document.querySelector('main, [role="main"], article') || document.body
    text = root?.innerText || document.body?.innerText || ''
  }
  text = tidyText(text)
  const meta = [byline && `By ${byline}`, siteName].filter(Boolean).join(' · ')
  if (meta) text = `${meta}\n\n${text}`
  const truncated = text.length > maxChars
  return {
    title,
    siteName: siteName || location.hostname,
    selection,
    text: truncated ? text.slice(0, maxChars) : text,
    chars: text.length,
    truncated,
  }
}

/**
 * A YouTube video's title, channel, description and transcript. The
 * transcript comes from YouTube's own transcript panel: opened if needed,
 * read, and closed again if ChroMind opened it.
 */
async function readYouTube(maxChars) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const SEGMENTS = 'ytd-transcript-segment-renderer, transcript-segment-view-model'
  const title =
    q('ytd-watch-metadata h1')?.innerText?.trim() || document.title.replace(/ - YouTube$/, '')
  const channel = q('ytd-watch-metadata #channel-name a, #owner #channel-name a')?.innerText?.trim() || ''
  const description = (q('ytd-watch-metadata #description-inline-expander, #description')?.innerText || '')
    .trim()
    .slice(0, 4000)

  let segments = document.querySelectorAll(SEGMENTS)
  let opened = false
  if (!segments.length) {
    const button =
      q('ytd-video-description-transcript-section-renderer button') ||
      [...document.querySelectorAll('button, yt-button-shape button')].find((b) =>
        /transcript/i.test(b.getAttribute('aria-label') || b.innerText || ''),
      )
    if (button) {
      // The description must be expanded for the button to work on some layouts.
      q('tp-yt-paper-button#expand, #description-inline-expander #expand')?.click()
      button.click()
      opened = true
      for (let i = 0; i < 40 && !segments.length; i++) {
        await sleep(150)
        segments = document.querySelectorAll(SEGMENTS)
      }
    }
  }
  const lines = [...segments]
    .map((seg) => {
      const time = (seg.querySelector('.segment-timestamp, [class*="timestamp"]')?.innerText || '').trim()
      const text = (seg.querySelector('.segment-text, yt-formatted-string, [class*="segment-text"]')?.innerText || seg.innerText || '')
        .replace(/\s+/g, ' ')
        .replace(time, '')
        .trim()
      return text ? (time ? `[${time}] ${text}` : text) : ''
    })
    .filter(Boolean)
  if (opened) {
    const panel = q('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]')
    panel?.querySelector('#visibility-button button, button[aria-label*="Close" i]')?.click()
  }
  if (!lines.length) return { title, text: '' }
  let body = `Video: ${title}\nChannel: ${channel}\n\nDescription:\n${description}\n\nTranscript:\n${lines.join('\n')}`
  const truncated = body.length > maxChars
  if (truncated) body = body.slice(0, maxChars)
  return { title, siteName: 'YouTube', text: body, chars: body.length, truncated, transcript: true, selection: '' }
}
