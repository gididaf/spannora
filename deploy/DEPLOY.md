# Deploying spannora to a Linux VPS

This walks through a one-time manual deploy. Phase 6 will turn this into a `curl | sh` installer; for now you do the steps yourself.

## Prerequisites on the VPS

- Ubuntu / Debian (or any systemd distro)
- **Node.js ≥ 20**
- **Caddy** (or any TLS-terminating reverse proxy)
- A domain pointing at the VPS

## 1. Create the service user

```bash
sudo useradd --system --create-home \
    --home-dir /home/spannora \
    --shell /bin/bash spannora
```

The user owns its own home so the Agent SDK can store its Claude Code auth in `~/.claude/`.

## 2. Extract the tarball

```bash
sudo mkdir -p /opt/spannora
sudo tar -xzf spannora-<version>.tar.gz -C /opt/spannora --strip-components=1
sudo chown -R spannora:spannora /opt/spannora
```

## 3. Install production dependencies

```bash
cd /opt/spannora
sudo -u spannora npm install --omit=dev
```

This installs `@anthropic-ai/claude-agent-sdk`, `better-sqlite3` (native — needs `build-essential` on Debian/Ubuntu), and `bcryptjs`.

## 4. Authenticate Claude Code

The Agent SDK ships its own bundled CLI at `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` — no separate Claude Code install is needed. It just needs credentials in `~/.claude/` for the `spannora` user.

```bash
sudo -iu spannora node /opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js
```

Inside the REPL: type `/login`, follow the OAuth URL in a browser, then `/exit`. Credentials land in `/home/spannora/.claude/` and the SDK reads them automatically on every request.

## 5. Install the systemd unit

```bash
sudo cp /opt/spannora/deploy/spannora.service /etc/systemd/system/spannora.service
sudo systemctl daemon-reload
sudo systemctl enable --now spannora
```

Check it came up:

```bash
sudo systemctl status spannora
sudo journalctl -u spannora -n 50
```

On first start the log will print a **one-time setup token** in a box. Copy it.

## 6. Configure Caddy

Copy the snippet, edit the hostname:

```bash
sudo cp /opt/spannora/deploy/Caddyfile.example /etc/caddy/conf.d/spannora.caddy
sudo $EDITOR /etc/caddy/conf.d/spannora.caddy   # replace your-domain.example.com
sudo systemctl reload caddy
```

(If your Caddyfile is a single file, paste the block into `/etc/caddy/Caddyfile` instead.)

## 7. Complete setup in the browser

Visit `https://<your-domain>` — Caddy provisions a Let's Encrypt cert (≈10 s on first hit), then redirects you to `/setup`. Paste the token from step 5 and pick a username / password. You're in.

## Where things live

| Path | What |
|---|---|
| `/opt/spannora/` | Application code (read-only by service) |
| `/var/lib/spannora/spannora.db` | SQLite — conversations, messages, users, sessions |
| `/home/spannora/.claude/` | Claude Code SDK auth |
| `/etc/systemd/system/spannora.service` | Service definition |
| `journalctl -u spannora` | Structured logs |

## Common operations

```bash
# Tail logs
sudo journalctl -u spannora -f

# Restart after editing the .service file
sudo systemctl daemon-reload && sudo systemctl restart spannora

# Reset all users + sessions (regenerates the setup token on next start)
sudo systemctl stop spannora
sudo -u spannora SPANNORA_RESET=1 node /opt/spannora/dist/server.js  # ctrl-C after the token prints
sudo systemctl start spannora

# Back up the DB
sudo -u spannora sqlite3 /var/lib/spannora/spannora.db ".backup '/tmp/spannora-backup.db'"
```

## Upgrading

Drop a newer tarball in `/opt/spannora` and restart:

```bash
sudo systemctl stop spannora
sudo tar -xzf spannora-<newer-version>.tar.gz -C /opt/spannora --strip-components=1
sudo chown -R spannora:spannora /opt/spannora
cd /opt/spannora && sudo -u spannora npm install --omit=dev
sudo systemctl start spannora
```

Schema migrations are idempotent (`CREATE TABLE IF NOT EXISTS`), so existing data is preserved.
