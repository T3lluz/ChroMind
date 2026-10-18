/**
 * Model lists for the picker: readable names, and families with their depths
 * (how hard the model thinks). Two kinds of depth:
 *   - in the id, the way Cursor ships them: claude-opus-5-5-high, …-max-fast
 *   - a "@depth" suffix ChroMind adds for CLIs that take a flag: opus@high
 *     (Claude Code's --effort; the same mark as the t3lluz dashboard's ids)
 */

export const DEPTHS = ['off', 'min', 'low', 'med', 'high', 'xhigh', 'max']
export const DEPTH_LABEL = { off: 'None', min: 'Minimal', low: 'Low', med: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

const DEPTH_WORDS = {
  none: 'off', off: 'off', minimal: 'min', min: 'min', low: 'low', medium: 'med', med: 'med',
  high: 'high', xhigh: 'xhigh', 'extra-high': 'xhigh', max: 'max',
}
const SUFFIX = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/

/** "claude-opus-5-5-high-fast" → { family: "claude-opus-5-5", depth: "high", fast: true }. */
export function splitVariant(id) {
  let rest = String(id)
  let depth = ''
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    depth = DEPTH_WORDS[rest.slice(at + 1)] ?? ''
    rest = rest.slice(0, at)
  }
  let fast = false
  if (rest.endsWith('-fast')) {
    fast = true
    rest = rest.slice(0, -5)
  }
  const m = SUFFIX.exec(rest)
  if (m && !depth) {
    depth = DEPTH_WORDS[m[1]]
    rest = rest.slice(0, m.index)
  }
  return { family: rest, depth, fast }
}

const UPPER = new Set(['gpt', 'glm', 'oss', 'vl', 'ai', 'r1', 'v3', 'v4', 'k2', 'k3', 'xl', 'it'])

/** "claude-opus-5-5" → "Claude Opus 5.5", "gpt-5.6-sol" → "GPT-5.6 Sol". */
export function prettyModel(id) {
  // OpenRouter-style "org/model" ids: the model part reads best.
  let s = String(id).replace(/^.*\//, '').replace(/^cursor-/, '')
  s = s.replace(/:free$/, '')
  s = s.replace(/(\d)-(\d)(?=$|-)/g, '$1.$2')
  const words = s.split(/[-_\s/]+/).filter(Boolean)
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const lower = w.toLowerCase()
    if (lower === 'gpt' && /^\d/.test(words[i + 1] ?? '')) {
      out.push(`GPT-${words[++i]}`)
    } else if (UPPER.has(lower)) {
      out.push(w.toUpperCase())
    } else if (/^\d/.test(w)) {
      out.push(w)
    } else {
      out.push(w[0].toUpperCase() + w.slice(1))
    }
  }
  return out.join(' ')
}

/** A model is free when its id says so (OpenCode, OpenRouter) or it's OpenCode's stealth model. */
export function isFree(id) {
  return /(-free|:free)$/.test(id) || id === 'big-pickle'
}

/**
 * Turns a flat list of { id, label?, free?, note? } into families:
 * [{ key, label, free, note, variants: [{ id, depth, fast }] }], in list order.
 * DEPTHS (optional) adds "@depth" variants to every model (CLI flags).
 */
export function groupModels(list, { depths = null } = {}) {
  const families = new Map()
  for (const item of list) {
    const entry = typeof item === 'string' ? { id: item } : item
    const { family, depth, fast } = splitVariant(entry.id)
    let fam = families.get(family)
    if (!fam) {
      fam = {
        key: family,
        label: entry.familyLabel || (depth || fast ? prettyModel(family) : entry.label || prettyModel(family)),
        free: !!entry.free || isFree(entry.id),
        note: entry.note || '',
        brand: entry.brand || '',
        source: entry.source || '',
        variants: [],
      }
      families.set(family, fam)
    }
    fam.variants.push({ id: entry.id, depth, fast })
    if (depths && !depth && !fast) {
      for (const d of depths) fam.variants.push({ id: `${entry.id}@${d}`, depth: d, fast: false })
    }
  }
  for (const fam of families.values()) {
    fam.variants.sort((a, b) => Number(a.fast) - Number(b.fast) || DEPTHS.indexOf(a.depth) - DEPTHS.indexOf(b.depth))
    fam.depths = [...new Set(fam.variants.map((v) => v.depth).filter(Boolean))].sort((a, b) => DEPTHS.indexOf(a) - DEPTHS.indexOf(b))
    fam.hasFast = fam.variants.some((v) => v.fast)
  }
  return [...families.values()]
}

/** The variant of FAMILY closest to DEPTH and FAST (for switching depth or the fast toggle). */
export function pickVariant(family, depth, fast) {
  const exact = family.variants.find((v) => v.depth === depth && v.fast === !!fast)
  if (exact) return exact
  const sameFast = family.variants.filter((v) => v.fast === !!fast)
  const pool = sameFast.length ? sameFast : family.variants
  if (!depth) return pool.find((v) => !v.depth) ?? pool[Math.floor(pool.length / 2)] ?? family.variants[0]
  const want = DEPTHS.indexOf(depth)
  return pool.reduce((best, v) =>
    Math.abs(DEPTHS.indexOf(v.depth) - want) < Math.abs(DEPTHS.indexOf(best.depth) - want) ? v : best,
  )
}

/** Where MODELID sits in GROUPS: { family, variant } or null. */
export function locate(groups, modelId) {
  for (const family of groups) {
    const variant = family.variants.find((v) => v.id === modelId)
    if (variant) return { family, variant }
  }
  return null
}

/** "Claude Opus 5.5 · High", for pills and message footers. */
export function modelTitle(groups, modelId, fallback = '') {
  const hit = locate(groups, modelId)
  if (!hit) return fallback || (modelId ? prettyModel(splitVariant(modelId).family) : '')
  const extra = [hit.variant.depth ? DEPTH_LABEL[hit.variant.depth] : '', hit.variant.fast ? 'Fast' : ''].filter(Boolean)
  return extra.length ? `${hit.family.label} · ${extra.join(' ')}` : hit.family.label
}
