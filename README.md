# spannora

Self-hosted web chat for [Claude Code](https://docs.claude.com/en/docs/claude-code/sdk) — install it on a Linux box, point a browser at it, and talk to Claude with real tool use against any working directory on the host.

- **Streaming chat** over Server-Sent Events
- **Pretty tool cards** — diffs for edits, formatted output for bash, file previews for write, etc.
- **Multi-thread** with SQLite persistence. Each conversation locks to a working directory and resumes via the SDK's session id.
- **In-app auth** (single user, bcrypt, session cookies) — sets up via a one-time token printed on first start.
- **Self-hosted, no cloud middleman** beyond Claude itself.

## Install (Linux + systemd)

```bash
curl -fsSL https://raw.githubusercontent.com/gididaf/spannora/main/install.sh | sudo bash
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
| `IS_SANDBOX` | unset | Set to `1` to opt into the SDK's "trusted" mode (installer sets this) |

### Installer

| Var | Default | Notes |
|---|---|---|
| `SPANNORA_DOMAIN` | `<public-ip>.sslip.io` | Hostname Caddy serves. Override with a real domain you own. |
| `SPANNORA_NO_PROXY` | unset | Set to `1` to skip Caddy install/config entirely — bring your own proxy. |

## License

MIT.
