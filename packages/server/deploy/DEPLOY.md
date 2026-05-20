# Deploying spannora to a Linux VPS

The one-line installer (`install.sh`) does all of this automatically. This doc walks through the same steps by hand for when you want to do something custom.

## Prerequisites on the VPS

- Linux with systemd (Ubuntu / Debian / Fedora / etc.)
- **Node.js ≥ 20**
- A public IPv4 (any cheap VPS provider qualifies)
- Root access (spannora runs as root by default — see "Why root" below)

## Why root

The default systemd unit has no `User=` line, so the service runs as root. The SDK reuses `/root/.claude/` for Claude Code auth — whatever account you've already logged `claude` into on this VM, spannora picks up automatically. Tool calls (Bash, Edit, Write…) inherit root's filesystem access, which is the whole point if you're using spannora to control a VM from your phone.

If you'd rather sandbox, add `User=<some-user>` + `Group=<some-user>` to `spannora.service` and authenticate Claude under that user instead. The SDK reads auth from `$HOME/.claude/`.

## 1. Extract the tarball

```bash
sudo mkdir -p /opt/spannora
sudo tar -xzf spannora-<version>.tar.gz -C /opt/spannora --strip-components=1
sudo chown -R root:root /opt/spannora
```

## 2. Install production dependencies

```bash
cd /opt/spannora
sudo npm install --omit=dev
```

Installs `@anthropic-ai/claude-agent-sdk`, `better-sqlite3` (native — needs `build-essential` on Debian/Ubuntu if no prebuilt binary), and `bcryptjs`.

## 3. Make sure Claude Code is authenticated for root

```bash
ls /root/.claude/ 2>/dev/null && echo "auth present" || echo "need to /login"
```

If absent:

```bash
sudo node /opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js
# inside the REPL:  /login  → URL  → sign in  →  /exit
```

The SDK ships its own bundled CLI at that path — no separate Claude Code install needed.

## 4. Install the systemd unit

The shipped unit is a template (`spannora.service.in`) with two placeholders that have to be substituted at install time:

- `@NODE_BIN@` — absolute path to the `node` binary. systemd's default PATH excludes nvm/asdf/fnm/volta/mise dirs, so `/usr/bin/env node` fails on those hosts.
- `@SVC_PATH@` — `PATH` the service inherits. Must include node's directory because the Agent SDK spawns a child `node <bundled-cli.js>` for each turn; without it, requests fail with "Failed to spawn Claude Code process".

```bash
NODE_BIN=$(readlink -f "$(command -v node)")
SVC_PATH="$(dirname "$NODE_BIN"):/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

sudo sed -e "s#@NODE_BIN@#${NODE_BIN}#g" \
         -e "s#@SVC_PATH@#${SVC_PATH}#g" \
         /opt/spannora/deploy/spannora.service.in \
  | sudo tee /etc/systemd/system/spannora.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now spannora
```

(`install.sh` does the same `sed` and de-dupes `SVC_PATH` while preserving order.)

Check:

```bash
sudo systemctl status spannora
sudo journalctl -u spannora -n 50
```

On first start the log prints a **one-time setup token** in a box. Copy it.

## 5. Reverse proxy

### Easy path: Caddy + sslip.io

If you don't have a domain and just want HTTPS:

```bash
# Install Caddy (Debian/Ubuntu):
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https gpg curl
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Find your public IP:
PUBLIC_IP=$(curl -fsSL https://api.ipify.org)

# Drop a Caddy snippet (replace IP in the hostname):
sudo mkdir -p /etc/caddy/conf.d
sudo tee /etc/caddy/conf.d/spannora.caddy >/dev/null <<EOF
${PUBLIC_IP}.sslip.io {
    reverse_proxy 127.0.0.1:7878 {
        transport http { read_timeout 1h }
    }
}
EOF

# Make sure the main Caddyfile imports conf.d:
grep -qE 'import[[:space:]]+(\./)?conf\.d/' /etc/caddy/Caddyfile \
  || echo 'import conf.d/*.caddy' | sudo tee -a /etc/caddy/Caddyfile

sudo systemctl reload caddy
```

Browse to `https://<your-ip>.sslip.io` — Caddy provisions a Let's Encrypt cert on first request.

### Custom domain

Same but replace `${PUBLIC_IP}.sslip.io` with your hostname. DNS A-record must point at this VPS before Caddy reloads (Let's Encrypt has to validate over HTTP).

### nginx / Apache / something else

Reverse-proxy `127.0.0.1:7878` with **upstream read timeout ≥ 1 hour** so streaming SSE responses don't get cut off mid-reply. Example for nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:7878;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_http_version 1.1;
}
```

## 6. Complete setup in the browser

Visit `https://<your-domain-or-sslip>` → /setup → paste the token from step 4 → pick a username/password. You're in.

## 7. Allow the hub PWA (optional)

The standalone hub PWA at `https://spannora.dev/app/` (or any self-hosted copy) is a different origin from this spannora instance, so the browser blocks its requests unless you opt in. Add the hub's origin to `SPANNORA_ALLOWED_ORIGINS`:

```bash
sudo systemctl edit spannora     # adds an override fragment
```

Paste:

```ini
[Service]
Environment=SPANNORA_ALLOWED_ORIGINS=https://spannora.dev
```

Save, then:

```bash
sudo systemctl restart spannora
```

Then open the hub in your browser, paste `https://<your-spannora>`, log in, and the hub remembers it as one of your workspaces. The hub holds a long-lived API token in its IndexedDB; you can revoke it any time from the in-server account modal (it shows as "API token · `<label>`").

To allow multiple origins (e.g. the public hub plus a local dev hub), use a comma-separated list:

```ini
Environment=SPANNORA_ALLOWED_ORIGINS=https://spannora.dev,http://localhost:5173
```

The default (env unset) emits no CORS headers at all — existing same-origin behavior is unchanged.

## Where things live

| Path | What |
|---|---|
| `/opt/spannora/` | Application code |
| `/var/lib/spannora/spannora.db` | SQLite: conversations, messages, users, sessions |
| `/root/.claude/` | Claude Code SDK auth |
| `/etc/systemd/system/spannora.service` | Service definition |
| `/etc/caddy/conf.d/spannora.caddy` | Caddy snippet (if installed) |
| `journalctl -u spannora` | Structured logs |

## Common operations

```bash
# Tail logs
sudo journalctl -u spannora -f

# Restart after editing the .service file
sudo systemctl daemon-reload && sudo systemctl restart spannora

# Reset all users + sessions (regenerates the setup token)
sudo systemctl stop spannora
sudo SPANNORA_RESET=1 node /opt/spannora/dist/server.js  # ctrl-C after the token prints
sudo systemctl start spannora

# Back up the DB
sudo sqlite3 /var/lib/spannora/spannora.db ".backup '/tmp/spannora-backup.db'"
```

## Upgrading

The cleanest path is to re-run the installer:

```bash
curl -fsSL https://spannora.dev/install.sh | sudo bash
```

Or by hand:

```bash
sudo systemctl stop spannora
sudo tar -xzf spannora-<newer-version>.tar.gz -C /opt/spannora --strip-components=1
sudo chown -R root:root /opt/spannora
cd /opt/spannora && sudo npm install --omit=dev
sudo systemctl start spannora
```

Schema migrations are idempotent (`CREATE TABLE IF NOT EXISTS`), so data is preserved.
