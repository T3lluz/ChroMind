/**
 * Every AI ChroMind can use, in picker order: what needs nothing first, then
 * your server, then apps on this computer (through the Bridge), then API keys.
 * ACCESS says how ChroMind gets in, shown as a badge everywhere a provider is.
 */

export const ACCESS = {
  account: { label: 'Your account', tone: 'account' },
  server: { label: 'Your server', tone: 'server' },
  free: { label: 'Free', tone: 'free' },
  app: { label: 'App on this PC', tone: 'app' },
  key: { label: 'API key', tone: 'key' },
  url: { label: 'Your URL', tone: 'url' },
}

export const PROVIDERS = [
  {
    id: 'claude-web',
    name: 'Claude',
    brand: 'claude',
    access: 'account',
    blurb: 'Your claude.ai login in this browser. Nothing to set up.',
    images: true,
  },
  {
    id: 'hermes',
    name: 'Your server',
    brand: 'nousresearch',
    access: 'server',
    blurb: "Hermes on your server, or your t3lluz dashboard's models. Address and password.",
    images: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    brand: 'opencode',
    access: 'free',
    blurb: 'Free models through the OpenCode app, or every model with an OpenCode Zen key.',
    images: false,
    zenUrl: 'https://opencode.ai/zen/v1',
    keyUrl: 'https://opencode.ai/auth',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    brand: 'claude',
    access: 'app',
    blurb: 'Your Claude plan through the Claude Code app, with thinking depth.',
    images: false,
    depths: ['low', 'med', 'high', 'xhigh', 'max'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    brand: 'cursor',
    access: 'app',
    blurb: "Your Cursor plan and every model on it, through Cursor's app.",
    images: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    brand: 'openrouter',
    access: 'key',
    blurb: 'Hundreds of models with one key, many of them free.',
    images: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    headers: { 'HTTP-Referer': 'https://t3lluz.github.io/ChroMind/', 'X-Title': 'ChroMind' },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    brand: 'gemini',
    access: 'key',
    blurb: 'Google AI Studio key, with a free tier.',
    images: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    brand: 'openai',
    access: 'key',
    blurb: 'GPT models with an OpenAI API key.',
    images: true,
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    brand: 'groq',
    access: 'key',
    blurb: 'Open models at very high speed.',
    images: false,
    baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'custom',
    name: 'Local model',
    brand: 'ollama',
    access: 'url',
    blurb: 'Ollama, LM Studio, or any OpenAI-compatible server.',
    images: true,
  },
]

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/** Claude's models on claude.ai. Empty id = whatever claude.ai would use. */
export const CLAUDE_WEB_MODELS = [
  { id: '', label: 'Claude', note: "claude.ai's default" },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'Most capable' },
]

export const CLAUDE_CODE_MODELS = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
  { id: 'fable', label: 'Claude Fable' },
]
