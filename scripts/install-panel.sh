#!/usr/bin/env bash
set -Eeuo pipefail

# CrazePanel production installer for Ubuntu 22.04/24.04 and Debian 12/13.
# Usage:
#   sudo bash scripts/install-panel.sh
#   sudo PANEL_DOMAIN=panel.example.com bash scripts/install-panel.sh
#
# Existing /etc/crazepanel/panel.env and /var/lib/crazepanel are preserved.

APP_DIR="${APP_DIR:-/opt/crazepanel}"
DATA_DIR="${DATA_DIR:-/var/lib/crazepanel}"
CONFIG_DIR="/etc/crazepanel"
ENV_FILE="$CONFIG_DIR/panel.env"
SERVICE_FILE="/etc/systemd/system/crazepanel-panel.service"
BRANCH="${APP_BRANCH:-main}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
REPO_URL="${REPO_URL:-https://github.com/CrazeStudio/panel.git}"

log() { printf '\n[CrazePanel] %s\n' "$*"; }
fail() { printf '\n[CrazePanel] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "Installation stopped at line $LINENO. Review the output above; existing panel data was not removed."' ERR

[[ "$(id -u)" -eq 0 ]] || fail "Run as root: sudo bash scripts/install-panel.sh"
[[ -r /etc/os-release ]] || fail "Cannot identify this Linux distribution."
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) fail "Supported systems: Ubuntu 22.04/24.04 and Debian 12/13. Detected: ${PRETTY_NAME:-unknown}." ;;
esac

if [[ -n "$PANEL_DOMAIN" ]] && ! [[ "$PANEL_DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; then
  fail "PANEL_DOMAIN must be a hostname such as panel.example.com."
fi

export DEBIAN_FRONTEND=noninteractive
log "Installing system dependencies."
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git openssl python3 make g++ build-essential

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ "$NODE_MAJOR" != "22" ]]; then
  log "Installing Node.js 22 LTS."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" == "22" ]] || fail "Node.js 22 is required; found $(node --version 2>/dev/null || echo unavailable)."

log "Preparing application directory."
if [[ -e "$APP_DIR" && ! -d "$APP_DIR/.git" ]]; then
  fail "$APP_DIR exists but is not a Git repository. Move it aside or set APP_DIR to a new path."
fi
if [[ -d "$APP_DIR/.git" ]]; then
  if [[ -n "$(git -C "$APP_DIR" status --porcelain)" ]]; then
    fail "$APP_DIR has uncommitted changes. Commit or back them up before updating; the installer will not overwrite them."
  fi
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
fi

log "Creating the service account and persistent data directories."
if ! id crazepanel >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin crazepanel
fi
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o root -g root -m 0755 "$CONFIG_DIR"
install -d -o crazepanel -g crazepanel -m 0750 "$DATA_DIR"

log "Installing production dependencies."
cd "$APP_DIR"
npm install --omit=dev --workspaces --include-workspace-root
npm run check

if [[ ! -f "$ENV_FILE" ]]; then
  APP_KEY="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=1
DATA_DIR=$DATA_DIR
PANEL_APP_KEY=$APP_KEY
SESSION_SECRET=$SESSION_SECRET
COOKIE_SECURE=true
EOF
  chmod 600 "$ENV_FILE"
  chown root:crazepanel "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  log "Generated fresh panel encryption and session secrets."
else
  log "Keeping existing $ENV_FILE unchanged."
  chown root:crazepanel "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

chown -R root:root "$APP_DIR"
chown -R crazepanel:crazepanel "$DATA_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CrazePanel Web Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=crazepanel
Group=crazepanel
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/panel/src/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now crazepanel-panel.service
systemctl restart crazepanel-panel.service
sleep 2
systemctl is-active --quiet crazepanel-panel.service || {
  systemctl --no-pager --full status crazepanel-panel.service || true
  fail "CrazePanel service did not start."
}
if ! curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  journalctl -u crazepanel-panel.service -n 60 --no-pager || true
  fail "Panel service started but its health endpoint did not respond."
fi

if [[ -n "$PANEL_DOMAIN" ]]; then
  log "Installing Caddy for automatic HTTPS on $PANEL_DOMAIN."
  apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<EOF
$PANEL_DOMAIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy
  log "HTTPS configured. Point the domain DNS A/AAAA records to this server and allow inbound TCP 80/443."
else
  log "No PANEL_DOMAIN supplied. Panel is listening only on 127.0.0.1:3000."
  log "Configure a reverse proxy with HTTPS before exposing the panel publicly."
fi

log "Installation completed."
echo "Health: http://127.0.0.1:3000/api/health"
if [[ -n "$PANEL_DOMAIN" ]]; then echo "Panel:  https://$PANEL_DOMAIN"; else echo "Panel:  http://127.0.0.1:3000 (local only; configure HTTPS proxy)"; fi
echo "First run: open the panel URL and create the first administrator."
echo "Service:  systemctl status crazepanel-panel"
echo "Logs:     journalctl -u crazepanel-panel -f"
echo "Data:     $DATA_DIR"
