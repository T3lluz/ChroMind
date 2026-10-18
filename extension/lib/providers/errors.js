/**
 * An error the UI can show as is. CODE lets the side panel pick a fix:
 * 'auth' (sign in), 'offline' (server not running), 'setup' (missing
 * settings), 'rate' (limits). LINK/LINKLABEL become a button; ACTION opens a
 * settings section; FIX is a command or setting to copy.
 */
export class ProviderError extends Error {
  constructor(message, { code = 'error', link = '', linkLabel = '', action = '', fix = '' } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.link = link
    this.linkLabel = linkLabel
    this.action = action
    this.fix = fix
  }
}

export function serializeError(err) {
  if (err?.name === 'AbortError') return { message: 'Stopped', code: 'aborted' }
  return {
    message: err?.message || String(err),
    code: err?.code || 'error',
    link: err?.link || '',
    linkLabel: err?.linkLabel || '',
    action: err?.action || '',
    fix: err?.fix || '',
  }
}
