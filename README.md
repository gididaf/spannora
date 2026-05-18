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
- creates a dedicated `spannora` system user with a home dir
- downloads the latest release tarball from GitHub
- extracts to `/opt/spannora`, runs `npm install --omit=dev`
- installs and starts a systemd unit (listens on `127.0.0.1:7878`)
- prints the Caddyfile snippet for you to paste

Re-running it upgrades in place. Existing SQLite data and Claude Code auth are preserved.

Then put a TLS terminator in front:

```caddy
chat.yourdomain.com {
    reverse_proxy 127.0.0.1:7878 {
        transport http { read_timeout 1h }
    }
}
```

Reload Caddy, visit `https://chat.yourdomain.com`. The first hit redirects to `/setup`; the one-time token is in `journalctl -u spannora`.

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

| Var | Default | Notes |
|---|---|---|
| `SPANNORA_HOST` | `127.0.0.1` | Bind address |
| `SPANNORA_PORT` | `7878` | TCP port |
| `SPANNORA_DB` | `~/.spannora/spannora.db` | SQLite path (installer overrides to `/var/lib/spannora/spannora.db`) |
| `SPANNORA_RESET` | unset | Set to `1` on startup to delete all users + sessions and regenerate the setup token |
| `IS_SANDBOX` | unset | Set to `1` to opt into the SDK's "trusted" mode (installer sets this) |

## License

MIT.
