/**
 * OpenCode's working indicator, as in TileSmith and DailyDash: eight blocks,
 * a bright one sweeping out and back with a fading trail, the resting blocks
 * drawn small. Frame for frame from opencode's ui/spinner.ts (getScannerState
 * and the knight-rider trail): 40 ms frames, a hold of 9 frames at the far
 * end and 30 at home.
 *
 * Classic script so content scripts can use it too:
 *   globalThis.CMScanner.create({ size, gap }) → element (starts and stops
 *   itself while it is in the document; a still frame with reduced motion).
 */
;(function () {
  const BLOCKS = 8
  const HOLD_START = 30
  const HOLD_END = 9
  const TRAIL = 6
  const FRAME_MS = 40
  const TOTAL = BLOCKS + HOLD_END + (BLOCKS - 1) + HOLD_START

  function state(frame) {
    const back = BLOCKS - 1
    if (frame < BLOCKS) return { active: frame, holding: false, hp: 0, ht: 0, mp: frame, mt: BLOCKS, forward: true }
    if (frame < BLOCKS + HOLD_END) return { active: BLOCKS - 1, holding: true, hp: frame - BLOCKS, ht: HOLD_END, mp: 0, mt: 0, forward: true }
    if (frame < BLOCKS + HOLD_END + back) {
      const b = frame - BLOCKS - HOLD_END
      return { active: BLOCKS - 2 - b, holding: false, hp: 0, ht: 0, mp: b, mt: back, forward: false }
    }
    return { active: 0, holding: true, hp: frame - BLOCKS - HOLD_END - back, ht: HOLD_START, mp: 0, mt: 0, forward: false }
  }

  function paint(blocks, frame) {
    const s = state(frame % TOTAL)
    const fade = s.holding && s.ht > 0
      ? Math.max(0.3, 1 - Math.min(s.hp / s.ht, 1) * 0.7)
      : !s.holding && s.mt > 0
        ? 0.3 + Math.min(s.mp / Math.max(1, s.mt - 1), 1) * 0.7
        : 1
    for (let i = 0; i < BLOCKS; i++) {
      const distance = s.forward ? s.active - i : i - s.active
      const trail = s.holding ? distance + s.hp : distance >= 0 && distance < TRAIL ? distance : -1
      const el = blocks[i]
      if (trail >= 0 && trail < TRAIL) {
        el.style.opacity = String(trail === 0 ? 1 : trail === 1 ? 0.9 : Math.pow(0.65, trail - 1))
        el.style.transform = 'scale(1)'
        el.style.filter = trail === 1 ? 'brightness(1.15)' : ''
      } else {
        el.style.opacity = String(0.6 * fade)
        el.style.transform = 'scale(0.42)'
        el.style.filter = ''
      }
    }
  }

  function create({ size = 5, gap = 2, label = 'Working' } = {}) {
    const root = document.createElement('span')
    root.className = 'cm-scanner'
    root.setAttribute('role', 'img')
    root.setAttribute('aria-label', label)
    root.style.cssText = `display:inline-flex;align-items:center;gap:${gap}px;height:${size}px;vertical-align:middle;flex-shrink:0;`
    const blocks = []
    for (let i = 0; i < BLOCKS; i++) {
      const b = document.createElement('i')
      b.style.cssText = `display:block;width:${size}px;height:${size}px;border-radius:${size * 0.22}px;background:currentColor;transition:none;`
      root.append(b)
      blocks.push(b)
    }
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let frame = BLOCKS - 1
    paint(blocks, frame)
    if (!reduced) {
      let timer = 0
      const tick = () => {
        if (!root.isConnected) {
          // Not attached yet, or removed: check again a little later, then give up.
          if (++root._idle > 50) return clearInterval(timer)
          return
        }
        root._idle = 0
        frame++
        paint(blocks, frame)
      }
      root._idle = 0
      timer = setInterval(tick, FRAME_MS)
      root._stop = () => clearInterval(timer)
    }
    return root
  }

  globalThis.CMScanner = { create, state, TOTAL }
})()
