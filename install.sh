#!/usr/bin/env bash
# spannora installer.
#
# Idempotent — re-run to upgrade in place. Preserves SQLite data and
# Claude Code auth across upgrades.
#
#   curl -fsSL https://spannora.dev/install.sh | sudo bash
#
# Environment overrides:
#   SPANNORA_DOMAIN      Use this hostname instead of <public-ip>.sslip.io
#   SPANNORA_NO_PROXY    Skip all reverse-proxy install/config
#   SPANNORA_NO_HTTPS    On nginx hosts, skip the certbot/HTTPS step
#   SPANNORA_ACME_EMAIL  Email used when registering with Let's Encrypt
#                        (default: anonymous registration, no expiry notices)

set -euo pipefail

REPO="gididaf/spannora"
INSTALL_DIR="/opt/spannora"
SERVICE_NAME="spannora"
NODE_MAJOR="20"
CADDY_CONF="/etc/caddy/conf.d/spannora.caddy"
CADDY_MAIN="/etc/caddy/Caddyfile"
NGINX_CONF="/etc/nginx/conf.d/spannora.conf"

say()  { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# --- Sanity ---
[[ "$(uname -s)" == "Linux" ]] || die "Only Linux is supported by this installer."
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

# --- Helper: detect existing reverse proxy ---
detect_existing_proxy() {
  if systemctl is-active --quiet nginx 2>/dev/null; then
    echo "nginx"; return
  fi
  if systemctl is-active --quiet apache2 2>/dev/null \
     || systemctl is-active --quiet httpd 2>/dev/null; then
    echo "apache"; return
  fi
  if command -v ss >/dev/null \
     && ss -tlnp 2>/dev/null | awk '{print $4}' | grep -qE ':(80|443)$'; then
    echo "other"; return
  fi
  echo ""
}

# --- Helper: install Caddy ---
install_caddy() {
  case "$PM" in
    apt)
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg curl >/dev/null
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -qq
      apt-get install -y caddy
      ;;
    dnf|yum)
      "$PM" install -y 'dnf-command(copr)' >/dev/null 2>&1 || true
      "$PM" copr enable -y @caddy/caddy
      "$PM" install -y caddy
      ;;
    *)
      return 1
      ;;
  esac
}

# --- Helper: configure Caddy for our domain ---
configure_caddy() {
  local domain="$1"
  say "Configuring Caddy for $domain"
  mkdir -p /etc/caddy/conf.d

  if [[ ! -f "$CADDY_MAIN" ]]; then
    echo 'import conf.d/*.caddy' > "$CADDY_MAIN"
  elif ! grep -qE 'import[[:space:]]+(\./)?conf\.d/' "$CADDY_MAIN"; then
    printf '\nimport conf.d/*.caddy\n' >> "$CADDY_MAIN"
  fi

  cat > "$CADDY_CONF" <<EOF
${domain} {
    reverse_proxy 127.0.0.1:7878 {
        transport http { read_timeout 1h }
    }
}
EOF

  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ok "Caddy serving $domain → 127.0.0.1:7878"
}

# --- Helper: install certbot for nginx if missing ---
install_certbot() {
  if command -v certbot >/dev/null; then
    return 0
  fi
  case "$PM" in
    apt)
      apt-get install -y certbot python3-certbot-nginx >/dev/null
      ;;
    dnf|yum)
      "$PM" install -y certbot python3-certbot-nginx
      ;;
    *)
      return 1
      ;;
  esac
}

# Set to 1 by configure_nginx if HTTPS via certbot succeeded.
NGINX_HTTPS=0

# --- Helper: configure nginx for our domain. Writes an HTTP-only proxy
# block, reloads, then runs certbot --nginx to add HTTPS (unless
# SPANNORA_NO_HTTPS is set). Idempotent: a re-run with a valid cert just
# re-applies the SSL directives to the freshly-overwritten config. ---
configure_nginx() {
  local domain="$1"
  say "Writing nginx config for $domain"
  mkdir -p /etc/nginx/conf.d

  cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${domain};

    # spannora streams long Server-Sent Events while Claude is thinking.
    # proxy_read_timeout 1h and disabled buffering keep responses flowing.
    location / {
        proxy_pass http://127.0.0.1:7878;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  if ! nginx -t >/dev/null 2>&1; then
    warn "nginx -t failed against the new config. Inspect with:  sudo nginx -t"
    warn "Config written to $NGINX_CONF but nginx was not reloaded."
    return
  fi
  systemctl reload nginx
  ok "nginx serving $domain → 127.0.0.1:7878 (HTTP)"

  # --- HTTPS via certbot ---
  if [[ -n "${SPANNORA_NO_HTTPS:-}" ]]; then
    return
  fi

  if ! install_certbot; then
    warn "Couldn't auto-install certbot on this distro."
    warn "Get HTTPS manually:  sudo certbot --nginx -d $domain"
    return
  fi

  local email_args
  if [[ -n "${SPANNORA_ACME_EMAIL:-}" ]]; then
    email_args="--email ${SPANNORA_ACME_EMAIL} --agree-tos --no-eff-email"
  else
    email_args="--register-unsafely-without-email --agree-tos"
  fi

  say "Provisioning Let's Encrypt cert for $domain (via certbot)"
  # --redirect adds the HTTP-to-HTTPS 301. --nginx plugin re-applies SSL
  # directives to our freshly-written server block on every run. If a
  # valid cert already exists for $domain, certbot reuses it.
  if certbot --nginx --non-interactive --redirect $email_args -d "$domain" >/tmp/spannora-certbot.log 2>&1; then
    NGINX_HTTPS=1
    ok "HTTPS active at https://$domain"
  else
    warn "certbot failed — spannora is reachable over HTTP only for now."
    warn "Log: /tmp/spannora-certbot.log"
    warn "Retry manually:  sudo certbot --nginx -d $domain"
  fi
}

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

# --- Latest release ---
say "Looking up latest release of $REPO"
release_json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
  || die "Couldn't fetch release info."

tarball_url=$(echo "$release_json" \
  | grep '"browser_download_url"' \
  | grep -o 'https://[^"]*\.tar\.gz' \
  | head -1)
version=$(echo "$release_json" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

[[ -n "$tarball_url" ]] || die "Latest release has no .tar.gz asset."
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
chown -R root:root "$INSTALL_DIR"
ok "Extracted to $INSTALL_DIR"

# --- Legacy migration ---
# Older installs used a dedicated `spannora` system user. If we find that
# user's Claude auth and root doesn't have its own, copy it over.
if [[ -d /home/spannora/.claude && ! -d /root/.claude ]]; then
  say "Migrating Claude Code auth from spannora user to /root/.claude"
  cp -r /home/spannora/.claude /root/
  chown -R root:root /root/.claude
  ok "Auth migrated"
fi
if [[ -d /var/lib/spannora ]]; then
  chown -R root:root /var/lib/spannora || true
fi

# --- npm install (prod only) ---
say "Installing production dependencies (this may take a minute)"
(cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund --silent) \
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
  ok "Service running on 127.0.0.1:7878"
else
  warn "Service did not start cleanly — inspect with: journalctl -u $SERVICE_NAME -n 50"
fi

# --- Reverse proxy ---
DOMAIN="${SPANNORA_DOMAIN:-}"
SETUP_PROXY=1
PROXY_KIND=""      # "caddy" | "nginx" | "" (none)
if [[ -n "${SPANNORA_NO_PROXY:-}" ]]; then
  SETUP_PROXY=0
fi

EXISTING_PROXY=$(detect_existing_proxy)
[[ -n "$EXISTING_PROXY" ]] && ok "Detected existing reverse proxy: $EXISTING_PROXY"

# Resolve domain (sslip.io if no override) — only useful when we're going
# to configure a proxy ourselves.
if [[ "$SETUP_PROXY" -eq 1 && -z "$DOMAIN" ]]; then
  say "Detecting public IPv4 for sslip.io"
  PUBLIC_IP=$(
    curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
    || curl -fsSL --max-time 5 https://icanhazip.com 2>/dev/null \
    || true
  )
  PUBLIC_IP=$(echo "${PUBLIC_IP:-}" | tr -d '[:space:]')
  if [[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    DOMAIN="${PUBLIC_IP}.sslip.io"
    ok "Public IPv4 $PUBLIC_IP → $DOMAIN"
  else
    warn "Couldn't auto-detect a public IPv4 address."
    warn "Set SPANNORA_DOMAIN=<your.domain> and re-run, or configure your proxy manually."
    SETUP_PROXY=0
  fi
fi

# Branch on which proxy we're talking to.
if [[ "$SETUP_PROXY" -eq 1 && -n "$DOMAIN" ]]; then
  case "$EXISTING_PROXY" in
    nginx)
      configure_nginx "$DOMAIN"
      PROXY_KIND="nginx"
      ;;
    apache|other)
      warn "An existing reverse proxy ($EXISTING_PROXY) is already serving :80/:443."
      warn "spannora's installer only auto-configures nginx and Caddy."
      warn "Configure your proxy manually to forward $DOMAIN → 127.0.0.1:7878."
      warn "Required: upstream read timeout >= 1h so SSE streams aren't cut off."
      ;;
    "")
      if ! command -v caddy >/dev/null; then
        say "Installing Caddy"
        if install_caddy; then
          ok "Caddy installed"
        else
          warn "Couldn't install Caddy on this distro. Configure your proxy manually."
          SETUP_PROXY=0
        fi
      else
        ok "Caddy already installed"
      fi
      if [[ "$SETUP_PROXY" -eq 1 ]]; then
        configure_caddy "$DOMAIN"
        PROXY_KIND="caddy"
      fi
      ;;
  esac
fi

# --- Setup token (only meaningful before first user is created) ---
sleep 1
setup_token=$(journalctl -u "$SERVICE_NAME" --no-pager -n 200 2>/dev/null \
  | grep -oE '[A-Za-z0-9_-]{32}' \
  | tail -1 || true)

cat <<EOF

  ╭─────────────────────────────────────────────────────────────────────╮
  │  spannora $version installed                                        │
  ╰─────────────────────────────────────────────────────────────────────╯

EOF

case "$PROXY_KIND" in
  caddy)
    cat <<EOF
  Open in your browser:

      https://$DOMAIN

  Caddy provisions a Let's Encrypt cert on first request — give it
  ~30 seconds before the HTTPS handshake settles.

EOF
    ;;
  nginx)
    if [[ "$NGINX_HTTPS" -eq 1 ]]; then
      cat <<EOF
  Open in your browser:

      https://$DOMAIN

  Let's Encrypt cert is in place. Auto-renewal is handled by the
  certbot.timer systemd unit (runs twice daily).

EOF
    else
      cat <<EOF
  Open in your browser (HTTP only for now):

      http://$DOMAIN

  HTTPS didn't come up automatically. Retry on this host:

      sudo certbot --nginx -d $DOMAIN

EOF
    fi
    ;;
  *)
    if [[ -n "$DOMAIN" ]]; then
      cat <<EOF
  spannora is listening on 127.0.0.1:7878. Point a reverse proxy at it
  for $DOMAIN, or:

      ssh -L 7878:127.0.0.1:7878 root@<this-host>
      # then http://localhost:7878 in your browser

EOF
    else
      cat <<EOF
  spannora is listening on 127.0.0.1:7878. To reach it from outside,
  either tunnel:

      ssh -L 7878:127.0.0.1:7878 root@<this-host>
      open http://localhost:7878

  or re-run with a domain set:

      SPANNORA_DOMAIN=chat.example.com bash <(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh)

EOF
    fi
    ;;
esac

if [[ -n "$setup_token" ]]; then
  cat <<EOF
  One-time setup token (single-use, regenerated on service restart):

      $setup_token

  Paste it on the setup page, then pick a username + password.

EOF
fi

# --- Claude auth check ---
if [[ -d /root/.claude ]]; then
  ok "Claude Code auth detected at /root/.claude — spannora will reuse it"
else
  cat <<EOF
  ! Claude Code isn't authenticated for root yet. Run once:

      node /opt/spannora/node_modules/@anthropic-ai/claude-agent-sdk/cli.js

    Inside the REPL: /login → URL → sign in → /exit

EOF
fi

cat <<EOF

  ! Note: spannora runs as root. Any tool call Claude makes (Bash, Edit,
    Write...) has full root privileges on this host. That's the point of
    'control my VMs from my phone' — but it means a careless prompt can
    nuke things. Treat it like a root shell.

  Re-run this installer to upgrade. Data and credentials persist.

EOF
