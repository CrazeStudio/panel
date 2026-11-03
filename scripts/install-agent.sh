#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/crazepanel}"
DATA_DIR="${DATA_DIR:-/var/lib/crazepanel}"
CONFIG_DIR="/etc/crazepanel"
ENV_FILE="$CONFIG_DIR/agent.env"
BRANCH="${APP_BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/CrazeStudio/panel.git}"

log() { printf '\n[CrazePanel Agent] %s\n' "$*"; }
fail() { printf '\n[CrazePanel Agent] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "Installation stopped at line $LINENO. Existing server data was not removed."' ERR

[[ "$(id -u)" -eq 0 ]] || fail "Run as root: sudo bash scripts/install-agent.sh"
[[ -r /etc/os-release ]] || fail "Cannot identify this Linux distribution."
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) fail "Supported systems: Ubuntu and Debian." ;; esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ build-essential

if ! command -v docker >/dev/null 2>&1; then
  log "Docker Engine is missing; installing it using Docker's official convenience installer."
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker
docker info >/dev/null 2>&1 || fail "Docker Engine is not responding. Check: systemctl status docker"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [[ "$NODE_MAJOR" != "22" ]]; then
  log "Installing Node.js 22 LTS."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" == "22" ]] || fail "Node.js 22 is required."

if [[ -d "$APP_DIR/.git" ]]; then
  if [[ -n "$(git -C "$APP_DIR" status --porcelain)" ]]; then
    fail "$APP_DIR has uncommitted changes. Commit or back them up before updating."
  fi
  git -C "$APP_DIR" fetch --prune origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
fi

if [[ -f "$ENV_FILE" ]]; then
  read -rsp "Existing agent configuration found. Replace its token/config? [y/N] " replace
  echo
  [[ "$replace" == "y" || "$replace" == "Y" ]] || fail "Cancelled without changing the existing agent configuration."
fi

read -rsp "Paste the one-time node token from CrazePanel: " NODE_TOKEN
echo
[[ "$NODE_TOKEN" =~ ^[a-fA-F0-9]{64}$ ]] || fail "The node token must be exactly 64 hexadecimal characters."

install -d -m 0700 "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/servers" "$DATA_DIR/backups"
cat > "$ENV_FILE" <<EOF
NODE_TOKEN=$NODE_TOKEN
AGENT_HOST=0.0.0.0
AGENT_PORT=8080
DOCKER_SOCKET=/var/run/docker.sock
SERVER_DATA_ROOT=$DATA_DIR/servers
BACKUP_ROOT=$DATA_DIR/backups
EGGS_FILE=$APP_DIR/eggs/index.json
EOF
chmod 600 "$ENV_FILE"

cd "$APP_DIR"
npm install --omit=dev --workspaces --include-workspace-root
cat > /etc/systemd/system/crazepanel-agent.service <<EOF
[Unit]
Description=CrazePanel Node Agent
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/agent/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
UMask=0027

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now crazepanel-agent.service
systemctl restart crazepanel-agent.service
sleep 2
systemctl is-active --quiet crazepanel-agent.service || {
  systemctl --no-pager --full status crazepanel-agent.service || true
  fail "Agent service did not start."
}
log "Agent installed. Restrict TCP 8080 to the panel host or a private VPN; do not expose it openly."
echo "Service: systemctl status crazepanel-agent"
echo "Logs:    journalctl -u crazepanel-agent -f"
echo "Data:    $DATA_DIR"
