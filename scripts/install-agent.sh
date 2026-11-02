#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/crazepanel}"
DATA_DIR="${DATA_DIR:-/var/lib/crazepanel}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo bash scripts/install-agent.sh"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -ge 25 ]; then
  echo "Node.js 22, 23 or 24 is required. Install Node.js 22 LTS first."
  exit 1
fi

if ! systemctl is-active --quiet docker; then
  echo "Docker Engine must be installed and running before installing the CrazePanel agent."
  exit 1
fi

apt-get update
apt-get install -y git tar ca-certificates

if [ ! -d "$APP_DIR/.git" ]; then
  git clone https://github.com/CrazeStudio/panel.git "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

read -rsp "Paste the one-time node token from CrazePanel: " NODE_TOKEN
echo
if ! [[ "$NODE_TOKEN" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "The node token must be 64 hexadecimal characters."
  exit 1
fi

mkdir -p /etc/crazepanel "$DATA_DIR/servers" "$DATA_DIR/backups"
chmod 700 /etc/crazepanel "$DATA_DIR"

cat > /etc/crazepanel/agent.env <<EOF
NODE_TOKEN=$NODE_TOKEN
AGENT_HOST=0.0.0.0
AGENT_PORT=8080
DOCKER_SOCKET=/var/run/docker.sock
SERVER_DATA_ROOT=$DATA_DIR/servers
BACKUP_ROOT=$DATA_DIR/backups
EGGS_FILE=$APP_DIR/eggs/index.json
EOF
chmod 600 /etc/crazepanel/agent.env

cd "$APP_DIR"
npm install --omit=dev
cp scripts/crazepanel-agent.service /etc/systemd/system/crazepanel-agent.service
systemctl daemon-reload
systemctl enable --now crazepanel-agent

echo
echo "CrazePanel agent installed and started on port 8080."
echo "Restrict this port to the panel host and use HTTPS or a private VPN for remote nodes."
