#!/usr/bin/env bash
# spannora installer.
#
# Idempotent — re-run to upgrade in place. Preserves SQLite data and
# Claude Code auth across upgrades.
#
#   curl -fsSL https://raw.githubusercontent.com/gididaf/spannora/main/install.sh | sudo bash

set -euo pipefail

REPO="gididaf/spannora"
INSTALL_DIR="/opt/spannora"
SERVICE_USER="spannora"
SERVICE_NAME="spannora"
NODE_MAJOR="20"

say()  { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# --- Sanity ---
[[ "$(uname -s)" == "Linux" ]] || die "Only Linux is supported by this installer. (Mac install coming later — for dev see README.)"
command -v systemctl >/dev/null || die "systemd is required."
command -v curl >/dev/null || die "curl is required."
command -v tar >/dev/null || die "tar is required."
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash <(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh)"

# --- Package manager ---
if   command -v apt-get >/dev/null; then PM=apt
elif command -v dnf     >/dev/null; then PM=dnf
elif command -v yum     >/dev/null; then PM=yum
else PM=unknown
fi

# --- Node ---
need_node=0
if command -v node >/dev/null; then
  current=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [[ "$current" -lt "$NODE_MAJOR" ]]; then need_node=1; fi
else
  need_node=1
fi

if [[ "$need_node" -eq 1 ]]; then
  say "Installing Node ${NODE_MAJOR}.x"
  case "$PM" in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      "$PM" install -y nodejs
      ;;
    *)
      die "Couldn't detect apt/dnf/yum. Install Node ${NODE_MAJOR}+ manually and re-run."
      ;;
  esac
  ok "Node $(node --version) installed"
else
  ok "Node $(node --version) already present"
fi

# --- Service user ---
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "User $SERVICE_USER already exists"
else
  say "Creating system user $SERVICE_USER"
  useradd --system --create-home --home-dir "/home/$SERVICE_USER" --shell /bin/bash "$SERVICE_USER"
  ok "User $SERVICE_USER created"
fi

# --- Latest release ---
say "Looking up latest release of $REPO"
release_json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
  || die "Couldn't fetch release info. Has a release been published?"

tarball_url=$(echo "$release_json" \
  | grep '"browser_download_url"' \
  | grep -o 'https://[^"]*\.tar\.gz' \
  | head -1)
version=$(echo "$release_json" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

[[ -n "$tarball_url" ]] || die "Latest release has no .tar.gz asset attached."
ok "Latest release: $version"

# --- Download + extract ---
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
say "Downloading $version"
curl -fsSL "$tarball_url" -o "$tmpdir/spannora.tar.gz"

if systemctl is-active --quiet "$SERVICE_NAME"; then
  say "Stopping running service for upgrade"
  systemctl stop "$SERVICE_NAME"
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmpdir/spannora.tar.gz" -C "$INSTALL_DIR" --strip-components=1
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
ok "Extracted to $INSTALL_DIR"

# --- npm install (prod only) ---
say "Installing production dependencies (this may take a minute)"
sudo -u "$SERVICE_USER" -- bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund --silent" \
  || die "npm install failed. If better-sqlite3 fails to build, install build tools: $PM install -y build-essential python3"
ok "Dependencies installed"

# --- systemd unit ---
say "Installing systemd unit"
install -m 644 "$INSTALL_DIR/deploy/spannora.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  ok "Service running (listening on 127.0.0.1:7878)"
else
  warn "Service did not start cleanly — inspect with: journalctl -u $SERVICE_NAME -n 50"
fi

# Try to extract the one-time setup token from the service log so we can
# display it directly. Token format is 32-char base64url (24 random bytes).
# Only present when no users exist yet — second-run upgrades have none.
setup_token=$(journalctl -u "$SERVICE_NAME" --no-pager -n 200 2>/dev/null \
  | grep -oE '[A-Za-z0-9_-]{32}' \
  | tail -1 || true)

cat <<EOF

  ╭─────────────────────────────────────────────────────────────────────╮
  │  spannora $version installed                                        │
  ╰─────────────────────────────────────────────────────────────────────╯

  Next steps:

  1. Authenticate Claude Code as the service user (once):

       sudo -iu $SERVICE_USER node /opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js

     Inside the REPL:  /login → URL → sign in → /exit
     Credentials land in /home/$SERVICE_USER/.claude/.

  2. Reverse proxy. Paste this prompt into your own Claude Code session
     (laptop or wherever — Claude needs SSH access to this host, or you
     can run it directly on this host) and let it handle the config:

       ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
       spannora is installed and running on this host as a systemd
       service, listening on 127.0.0.1:7878. Please set up a reverse
       proxy for it, terminating HTTPS.

       - Domain: <REPLACE_WITH_YOUR_DOMAIN>
       - Upstream: 127.0.0.1:7878
       - Detect Caddy, nginx, or Apache. If none, recommend Caddy and
         pause for me to install it.
       - Critical: upstream read timeout >= 1 hour. spannora streams
         long Server-Sent Events while Claude is thinking; default
         timeouts cut responses off mid-reply.
       - Reload the proxy and verify with
             curl -fsSI https://<DOMAIN>
         that it returns a 200 or 302.
       ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄

     Or do it manually — Caddy snippet (drop into /etc/caddy/Caddyfile):

         <DOMAIN> {
             reverse_proxy 127.0.0.1:7878 {
                 transport http { read_timeout 1h }
             }
         }
EOF

if [[ -n "$setup_token" ]]; then
  cat <<EOF

  3. One-time setup token (single-use, regenerated on service restart):

         $setup_token

     Visit https://<DOMAIN> once the proxy is up. Paste this token on the
     setup page, choose a username + password, and you're chatting.
EOF
else
  cat <<EOF

  3. This host already has a spannora user account — no setup token needed.
     Visit https://<DOMAIN> once the proxy is up and sign in.
EOF
fi

cat <<EOF

  Re-run this installer any time to upgrade. Data and credentials persist.

EOF
