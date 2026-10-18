/**
 * Maker logos for providers and models (LobeHub Icons, MIT; the logos are
 * their owners' trademarks and only identify their services). Colored logos
 * render as images; one-color ones are masks tinted to fit the theme.
 */
import { api } from './browser.js'

const COLORED = new Set([
  'baidu', 'claude', 'cohere', 'deepseek', 'doubao', 'gemini', 'google', 'huggingface', 'kimi', 'longcat',
  'meta', 'microsoft', 'mistral', 'nvidia', 'perplexity', 'qwen', 'stepfun', 'zhipu',
])

/** One-color logos with a brand tint; the rest follow the text color. */
const TINT = {
  anthropic: '#D97757',
  nousresearch: '#A78BFA',
  openrouter: '#7C7CF8',
  groq: '#F55036',
  xiaomimimo: '#FF6900',
}

const KNOWN = new Set([
  ...COLORED, 'ai21', 'anthropic', 'cursor', 'githubcopilot', 'grok', 'groq', 'liquid', 'lmstudio', 'minimax',
  'nousresearch', 'ollama', 'openai', 'opencode', 'openrouter', 'xiaomimimo',
])

const RULES = [
  [/claude|opus|sonnet|haiku|fable|mythos/, 'claude'],
  [/gpt|^o\d|openai|codex|chatgpt/, 'openai'],
  [/gemini|gemma/, 'gemini'],
  [/grok/, 'grok'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'],
  [/kimi|moonshot/, 'kimi'],
  [/glm|zhipu|chatglm|z-ai/, 'zhipu'],
  [/mistral|mixtral|codestral|devstral|magistral|ministral|pixtral/, 'mistral'],
  [/llama|meta-/, 'meta'],
  [/nemotron|nvidia/, 'nvidia'],
  [/minimax/, 'minimax'],
  [/longcat/, 'longcat'],
  [/mimo/, 'xiaomimimo'],
  [/composer|cursor/, 'cursor'],
  [/big-pickle|opencode/, 'opencode'],
  [/hermes|nous/, 'nousresearch'],
  [/command-|cohere|aya/, 'cohere'],
  [/phi-|microsoft/, 'microsoft'],
  [/sonar|perplexity/, 'perplexity'],
  [/doubao|seed-/, 'doubao'],
  [/ernie/, 'baidu'],
  [/step-/, 'stepfun'],
  [/lfm|liquid/, 'liquid'],
  [/jamba/, 'ai21'],
]

/** The maker of MODELID, or FALLBACK (usually the provider's own brand). */
export function brandFor(modelId, fallback = 'opencode') {
  const id = String(modelId || '').toLowerCase()
  for (const [re, brand] of RULES) if (re.test(id)) return brand
  return KNOWN.has(fallback) ? fallback : 'opencode'
}

function url(brand) {
  return api?.runtime?.getURL ? api.runtime.getURL(`icons/brands/${brand}.svg`) : `../icons/brands/${brand}.svg`
}

/** HTML for a logo of BRAND, SIZE pixels square. */
export function logo(brand, size = 18, extraClass = '') {
  const b = KNOWN.has(brand) ? brand : 'opencode'
  const cls = `brand-logo${extraClass ? ' ' + extraClass : ''}`
  if (COLORED.has(b)) {
    return `<img class="${cls}" src="${url(b)}" width="${size}" height="${size}" alt="" draggable="false">`
  }
  const tint = TINT[b] ? `color:${TINT[b]};` : ''
  return `<span class="${cls} mono" style="${tint}width:${size}px;height:${size}px;--logo:url('${url(b)}')" aria-hidden="true"></span>`
}
