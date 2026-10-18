<div align="center">
  <img src="extension/icons/icon.svg" width="72" height="72" alt="ChroMind" />
  <h1>ChroMind</h1>
  <p>An AI side panel for Firefox and Chromium that answers with the AI you already have:<br/>
  your <b>Claude</b> login, <b>your server</b> (Hermes), <b>OpenCode</b>'s free models, <b>Claude Code</b> and <b>Cursor</b>, or an API key.</p>
  <p>
    <img alt="Version" src="https://img.shields.io/badge/v0.3.0-111111?label=version" />
    <img alt="Manifest V3" src="https://img.shields.io/badge/MV3-3ee6b0" />
    <img alt="Firefox 140+" src="https://img.shields.io/badge/Firefox-140%2B-22d3ee?logo=firefoxbrowser&logoColor=white" />
    <img alt="Chrome 116+" src="https://img.shields.io/badge/Chromium-116%2B-22d3ee?logo=googlechrome&logoColor=white" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-34413e" />
  </p>
  <p><a href="https://t3lluz.github.io/ChroMind/"><b>Website & docs</b></a> · <a href="https://t3lluz.github.io/ChroMind/docs/install/">Install</a> · <a href="https://t3lluz.github.io/ChroMind/docs/providers/">Providers</a> · <a href="https://t3lluz.github.io/ChroMind/docs/hermes/">Your server</a></p>
  <img src="site/assets/screens/panel-answer.png" width="360" alt="ChroMind summarizing a page" />
</div>

## Features

- **Chat with the page.** Article text via Mozilla Readability; a Page switch to leave it out. Follow-ups keep the context.
- **AI picker:** every provider and model in one place, with makers' logos, thinking depth (Low to Max, Fast), *Free* badges and search.
- **Quick actions and `/` commands:** summarize, key points, explain, ELI5, translate, simplify, improve writing, draft a reply, fact-check, action items, suggested questions, compare tabs, describe image. Add your own with `{{target}}` placeholders.
- **Selection toolbar:** select text → Explain / Summarize / Translate / Ask, answered in a floating card, handed off to the panel to keep chatting.
- **Right-click menus** on pages, selections, links (summarize without opening) and images.
- **YouTube:** reads the transcript; answers cite `[mm:ss]` moments you click to seek.
- **Several tabs, screenshots**, chat **history** with search and Markdown export, read aloud, address-bar keyword `cm`.
- ChroMods' glass look in mint and cyan, dark and light, and OpenCode's working indicator.

## Install

| Browser | How |
|---|---|
| Firefox, Zen, LibreWolf, Floorp | One click from [the install page](https://t3lluz.github.io/ChroMind/docs/install/#firefox) (signed by Mozilla, updates itself) |
| Chrome, Edge, Brave, Vivaldi, Arc | Download the zip from [the install page](https://t3lluz.github.io/ChroMind/docs/install/#chrome) → `chrome://extensions` → Developer mode → Load unpacked |

From source: load `extension/` as unpacked in Chromium, or `npm run dev:firefox` / `npm run dev:zen`.

## Providers

| Provider | Badge | Setup |
|---|---|---|
| Claude | Your account | Be signed in to claude.ai |
| Your server | Your server | Address + password: finds your dashboard or Hermes' API ([guide](https://t3lluz.github.io/ChroMind/docs/hermes/)) |
| OpenCode | Free | The OpenCode app through the [Bridge](#bridge), or a Zen key |
| Claude Code, Cursor | App on this PC | [Bridge](#bridge) |
| OpenRouter, Gemini, OpenAI, Groq | API key | Paste a key |
| Local model | Your URL | Ollama, LM Studio, any OpenAI-style server |

## Bridge

Only for the apps on your computer (Claude Code, Cursor, OpenCode's free models). [`bridge/chromind-bridge.mjs`](bridge/chromind-bridge.mjs) is one dependency-free Node 20+ file serving an OpenAI-style API on `127.0.0.1:8765`. It runs Claude Code with all tools off, Cursor in read-only ask mode and OpenCode with every permission on ask, each in an empty scratch folder. It's closed to web pages, and ChroMind pairs with it by itself.

```bash
node chromind-bridge.mjs install    # start it now and with your computer (Windows, macOS, Linux)
node chromind-bridge.mjs            # or run it in this window
```

## Development

```bash
npm install
npm test             # unit tests (node --test)
npm run test:e2e     # Playwright: loads the extension in Chromium with its own Bridge
npm run lint:firefox # Mozilla's linter on the Firefox build
npm run pack         # dist/chromind-chrome.zip, dist/chromind-firefox-unsigned.xpi
npm run dev:site     # docs at http://localhost:4173/ChroMind/
npm run screenshots  # refresh site/assets/screens from the real extension
```

One codebase serves both browsers: `extension/manifest.json` is the Chromium manifest and `scripts/extension-files.mjs` derives Firefox's (sidebar_action, event page, gecko id, update URL). See [AGENTS.md](AGENTS.md) and the [development docs](https://t3lluz.github.io/ChroMind/docs/development/).

### Releases and Firefox signing

Pushing to `main` runs [`pages.yml`](.github/workflows/pages.yml): tests, packages, gets the Firefox build signed as an **unlisted** add-on from your AMO developer account (secrets `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`), and deploys the docs with the downloads and Firefox's update manifest to GitHub Pages. Bump the version to ship: `npm run release -- patch`.

## Privacy

No server of ours, no analytics. Questions and page text go only to the provider you pick; settings, keys and chats stay in the browser. [Details](https://t3lluz.github.io/ChroMind/docs/privacy/).

## License

MIT. Includes [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0) and [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Sibling of [ChroMods](https://github.com/T3lluz/ChroMods).
