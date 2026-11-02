#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/crazepanel}"
DATA_DIR="${DATA_DIR:-/var/lib/crazepanel}"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo bash scripts/install-panel.sh"
  exit 1
fi

if [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -ge 25 ]; then
  echo "Node.js 22, 23 or 24 is required. Install Node.js 22 LTS first."
  exit 1
fi

apt-get update
apt-get install -y git openssl ca-certificates

if [ ! -d "$APP_DIR/.git" ]; then
  git clone https://github.com/CrazeStudio/panel.git "$APP_DIR"
else
  git -C "$APP_DIR" pull --ff-only
fi

id crazepanel >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --create-home --shell /usr/sbin/nologin crazepanel
mkdir -p /etc/crazepanel "$DATA_DIR"
chmod 700 /etc/crazepanel "$DATA_DIR"

if [ ! -f /etc/crazepanel/panel.env ]; then
  APP_KEY="$(openssl rand -hex 32)"
  SESSION_SECRET="$(openssl rand -base64 48)"
  cat > /etc/crazepanel/panel.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=1
DATA_DIR=$DATA_DIR
PANEL_APP_KEY=$APP_KEY
SESSION_SECRET=$SESSION_SECRET
COOKIE_SECURE=true
EOF
  chmod 600 /etc/crazepanel/panel.env
fi

cd "$APP_DIR"
npm install --omit=dev
cp scripts/crazepanel-panel.service /etc/systemd/system/crazepanel-panel.service
chown -R root:root "$APP_DIR"
chown -R crazepanel:crazepanel "$DATA_DIR"
systemctl daemon-reload
systemctl enable --now crazepanel-panel

echo
echo "CrazePanel is running on http://127.0.0.1:3000"
echo "Configure HTTPS with Nginx or Caddy before making it public."
echo "Create the first administrator account in the browser."
