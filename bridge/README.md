# ChroMind Bridge

Lets the ChroMind extension use the apps on this computer with the accounts they're signed in to: **Claude Code** (`claude`), **Cursor** (`cursor-agent`) and **OpenCode** (`opencode`, free models need no account). One file, no dependencies, Node 20+. ChroMind pairs with it by itself.

```bash
node chromind-bridge.mjs install    # start it now and with your computer (Windows Startup / launchd / systemd --user)
node chromind-bridge.mjs            # or run it in this window
node chromind-bridge.mjs status     # which apps it found, versions, sign-in state
node chromind-bridge.mjs token      # print the token (for other tools)
node chromind-bridge.mjs uninstall
```

Sign the apps in first: `claude auth login`, `cursor-agent login`.

- OpenAI-style API on `127.0.0.1:8765`: `/v1/chat/completions` (streaming), `/v1/models`, `/v1/status` (`?fresh` to check again), `/v1/pair`, `/health`.
- Models: `claude-code/<opus|sonnet|haiku|fable>[@low|med|high|xhigh|max]`, `cursor/<auto|any model cursor-agent lists>`, `opencode/<model>`.
- `/v1/chat/completions`, `/v1/models` and `/v1/status` need `Authorization: Bearer <token>` (`~/.chromind/bridge.json`). `/v1/pair` hands the token to the extension. Requests with an `http(s)://` Origin (web pages) and requests not addressed to `127.0.0.1` / `localhost` are refused.
- Claude Code runs with every tool off, no MCP, no slash commands, no saved session; Cursor in `--mode ask`; OpenCode with every permission on ask. Each run gets a fresh empty folder.

Environment: `CHROMIND_BRIDGE_PORT`, `CHROMIND_BRIDGE_HOST`, `CHROMIND_HOME`, `CHROMIND_CLAUDE_BIN`, `CHROMIND_CURSOR_BIN`, `CHROMIND_OPENCODE_BIN`, `CHROMIND_BRIDGE_TIMEOUT`.

Full guide: https://t3lluz.github.io/ChroMind/docs/bridge/
