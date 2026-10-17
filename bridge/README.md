# ChroMind Bridge

Lets the ChroMind extension use the **Claude Code** (`claude`) and **Cursor** (`cursor-agent`) CLIs with the accounts they're signed in to. One file, no dependencies, Node 20+.

```bash
node chromind-bridge.mjs            # start; prints the token to paste in ChroMind → Settings → Bridge
node chromind-bridge.mjs token      # print the token
node chromind-bridge.mjs status     # which CLIs it found, versions, sign-in state
node chromind-bridge.mjs install    # start with your computer (Windows Startup / launchd / systemd --user)
node chromind-bridge.mjs uninstall
```

Sign the CLIs in first: `claude auth login`, `cursor-agent login`.

- OpenAI-compatible API on `127.0.0.1:8765`: `/v1/chat/completions` (streaming), `/v1/models`, `/v1/status`, `/v1/server/test`, `/health`.
- Models: `claude-code/<sonnet|opus|haiku|fable>`, `cursor/<auto|any model cursor-agent lists>`, `hermes/<model>` (SSH tunnel to your server).
- Hermes: send `X-ChroMind-Server: you@host` and `X-ChroMind-Server-Password`; the Bridge tunnels to `127.0.0.1:8642` on that machine (same login style as TileSmith / DailyDash). Needs the system `ssh` client.
- Every `/v1` call needs `Authorization: Bearer <token>` (`~/.chromind/bridge.json`). Requests with an `http(s)://` Origin (web pages) are refused.
- Claude Code runs with `--tools ""`, no MCP, no slash commands, no saved session; Cursor in `--mode ask`. Each run gets a fresh empty folder.

Environment: `CHROMIND_BRIDGE_PORT`, `CHROMIND_BRIDGE_HOST`, `CHROMIND_CLAUDE_BIN`, `CHROMIND_CURSOR_BIN`, `CHROMIND_BRIDGE_TIMEOUT`.

Full guide: https://t3lluz.github.io/ChroMind/docs/bridge/
