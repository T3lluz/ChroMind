/**
 * Opening links from answers without piling up tabs: a YouTube link (or a
 * [mm:ss] timestamp) seeks the tab that already plays that video, a link to
 * a page that's already open switches to it, and anything else opens next
 * to the current tab.
 */
import { api } from './browser.js'
import { seekVideo } from './extract.js'

const withoutHash = (url = '') => url.split('#')[0]

export function videoId(url) {
  return globalThis.CMMarkdown?.youTube(url)?.id ?? null
}

/** The tab showing YouTube video ID: this window's active tab first, then this window, then any. */
export async function findVideoTab(id, windowId) {
  if (!id) return null
  const tabs = await api.tabs.query({ url: ['*://*.youtube.com/*', '*://youtu.be/*'] }).catch(() => [])
  const hits = tabs.filter((t) => videoId(t.url) === id)
  const score = (t) => (t.windowId === windowId ? 2 : 0) + (t.active ? 1 : 0)
  return hits.sort((a, b) => score(b) - score(a))[0] ?? null
}

async function focus(tab) {
  if (!tab.active) await api.tabs.update(tab.id, { active: true }).catch(() => {})
  await api.windows?.update(tab.windowId, { focused: true }).catch(() => {})
}

/** Seeks video ID to SECONDS in an open tab, or opens it there. */
export async function playAt(id, seconds, windowId) {
  const tab = await findVideoTab(id, windowId)
  if (tab) {
    await seekVideo(tab.id, seconds)
    return focus(tab)
  }
  return openTab(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&t=${Math.floor(seconds)}s`, windowId)
}

async function openTab(url, windowId) {
  const [active] = await api.tabs.query({ active: true, windowId }).catch(() => [])
  return api.tabs.create({
    url,
    ...(typeof windowId === 'number' ? { windowId } : {}),
    ...(active ? { index: active.index + 1, openerTabId: active.id } : {}),
  })
}

/** Opens URL from an answer in WINDOWID, reusing a tab when one fits. */
export async function openLink(url, windowId) {
  const yt = globalThis.CMMarkdown?.youTube(url)
  if (yt) {
    const tab = await findVideoTab(yt.id, windowId)
    if (tab) {
      if (yt.seconds != null) await seekVideo(tab.id, yt.seconds)
      return focus(tab)
    }
  }
  const tabs = await api.tabs.query({ windowId }).catch(() => [])
  const same = tabs.find((t) => withoutHash(t.url) === withoutHash(url))
  if (same) {
    if (same.url !== url) await api.tabs.update(same.id, { url }).catch(() => {})
    return focus(same)
  }
  return openTab(url, windowId)
}
