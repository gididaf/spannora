# spannora

Self-hosted web chat for [Claude Code](https://docs.claude.com/en/docs/claude-code/sdk) — install it on a Linux box, point a browser at it, and talk to Claude with real tool use against any working directory on the host.

- **Streaming chat** over Server-Sent Events
- **Pretty tool cards** — diffs for edits, formatted output for bash, file previews for write, etc.
- **Multi-thread** with SQLite persistence. Each conversation locks to a working directory and resumes via the SDK's session id.
- **In-app auth** (single user, bcrypt, session cookies) — sets up via a one-time token printed on first start.
- **Installable PWA** — once it's serving over HTTPS, the browser's "Install app" / "Add to home screen" turns spannora into a standalone app on desktop, Android, and iOS.
- **Self-hosted, no cloud middleman** beyond Claude itself.

## Install (Linux + systemd)

```bash
curl -fsSL https://spannora.dev/install.sh | sudo bash
```

The script:

- installs Node 20+ if missing (via NodeSource)
- downloads the latest release tarball, extracts to `/opt/spannora`, `npm install --omit=dev`
- installs and starts a systemd unit running as **root** (so the SDK reuses `/root/.claude/` — wherever you already log `claude` in on your VMs, spannora picks it up)
- detects the public IP and **auto-installs Caddy with a Let's Encrypt cert for `<ip>.sslip.io`** by default
- prints the URL and one-time setup token

Re-running it upgrades in place. Existing SQLite data and Claude Code auth are preserved.

**Override the auto-domain** by setting `SPANNORA_DOMAIN=your.domain` before running the installer. **Skip the proxy entirely** with `SPANNORA_NO_PROXY=1`.

> ⚠️ Running as root means tool calls (Bash, Edit, Write…) have full root access on the host. That's the point for the "control my VM from my phone" workflow, but a careless prompt can do real damage. Treat the web UI like a root shell.

Full step-by-step (no installer) lives in [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

## Develop locally (Mac / Linux)

```bash
git clone https://github.com/gididaf/spannora.git
cd spannora
npm install
npm run dev
```

Open `http://localhost:7878`. The first visit redirects to `/setup`; the token is printed on `tsx` startup.

## Architecture in one diagram

```
 Browser ──HTTPS──► Caddy ──HTTP──► spannora (Node) ──SDK──► Claude Code
                                       │
                                       └─► SQLite (~/.spannora or /var/lib/spannora)
```

- Plain Node `http` server (no Fastify/Express)
- TypeScript Agent SDK with `permissionMode: 'bypassPermissions'` + `IS_SANDBOX=1` (full filesystem access in the working directory)
- Vanilla JS frontend — single `app.js`, no framework
- Native `<details>/<summary>` for tool cards (sidesteps iOS Safari flex quirks)

## Environment variables

### spannora runtime

| Var | Default | Notes |
|---|---|---|
| `SPANNORA_HOST` | `127.0.0.1` | Bind address |
| `SPANNORA_PORT` | `7878` | TCP port |
| `SPANNORA_DB` | `~/.spannora/spannora.db` | SQLite path (installer overrides to `/var/lib/spannora/spannora.db`) |
| `SPANNORA_RESET` | unset | Set to `1` on startup to delete all users + sessions and regenerate the setup token |
| `SPANNORA_RETENTION_DAYS` | unset | Auto-delete conversations untouched for more than N days. Also removes the matching `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Sweep runs hourly. |
| `SPANNORA_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Logs are one JSON object per line — pipe through `jq` or `journalctl -o json`. |
| `SPANNORA_CONTEXT_WINDOW` | `200000` | Fallback context-window denominator for the sidebar `% ctx` chip when the SDK doesn't surface `modelUsage[*].contextWindow`. |
| `IS_SANDBOX` | unset | Set to `1` to opt into the SDK's "trusted" mode (installer sets this) |

### Installer

| Var | Default | Notes |
|---|---|---|
| `SPANNORA_DOMAIN` | `<public-ip>.sslip.io` | Hostname the reverse proxy serves. Override with a real domain you own. |
| `SPANNORA_NO_PROXY` | unset | Set to `1` to skip both Caddy and nginx setup — bring your own proxy. |
| `SPANNORA_NO_HTTPS` | unset | On nginx hosts, write the HTTP block but skip the certbot/Let's Encrypt step. |
| `SPANNORA_ACME_EMAIL` | unset | Email registered with Let's Encrypt (used for renewal/breach notices). Without it, certbot registers anonymously. |

## License

MIT.
