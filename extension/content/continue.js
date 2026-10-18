/**
 * Firefox opens the sidebar only from a click in the extension's own UI,
 * not from a click a content script relays. So the selection card shows
 * this page as its "Continue in side panel" button: the click lands here,
 * opens the sidebar, and asks the background to show the chat there.
 */
const api = globalThis.browser ?? globalThis.chrome
const params = new URLSearchParams(location.search)
if (params.get('theme') === 'light') document.documentElement.className = 'light'

const button = document.getElementById('go')
button.addEventListener('click', () => {
  // Synchronously, while the click still counts as a user action.
  const opening = api.sidebarAction?.open ? api.sidebarAction.open().then(() => true, () => false) : Promise.resolve(false)
  button.disabled = true
  opening
    .then((opened) => api.runtime.sendMessage({ type: 'open-thread', threadId: params.get('thread'), opened }))
    .catch(() => null)
    .then((res) => parent.postMessage({ chromind: 'continued', ok: !!res?.opened }, '*'))
    .finally(() => (button.disabled = false))
})
parent.postMessage({ chromind: 'continue-ready' }, '*')
