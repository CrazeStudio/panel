# CrazePanel 2

CrazePanel is a self-hosted Minecraft server control panel built with Node.js. It is split into a web panel and a node agent. The panel stores accounts and server metadata; the agent runs on each host and performs Docker operations against that host's Docker Engine.

This repository follows the Node.js / Express / Dockerode architecture used by the earlier Skyport panel/daemon model. It does not copy Skyport source code or branding.

## What is included

- First-run administrator setup; bcrypt password hashes; SQLite-backed sessions; CSRF protection; login rate limiting.
- Multiple nodes with generated, one-time agent tokens encrypted at rest in the panel database.
- Docker-managed Minecraft Java servers: Paper, Purpur, Vanilla, Fabric, Forge and NeoForge; plus Bedrock Dedicated Server.
- Start, stop, restart and kill actions; live process state and Docker resource metrics.
- Console logs and command input using the attached container stream.
- Per-server file listing, text editing, upload, create-folder and delete with path traversal and symlink checks.
- Full server directory backups and restore while the server is stopped.
- Resource limit updates, panel user administration and administrator audit log.
- Responsive browser UI and a session-authenticated JSON API.
- Installer scripts, systemd service units, Dockerfiles, Docker Compose and automated tests.

## Architecture

```text
CrazePanel/
├── panel/
│   ├── public/             # Browser UI
│   └── src/
│       ├── routes/         # Auth, nodes, servers, admin
│       ├── lib/            # Agent client, encryption, audit, eggs
│       ├── middleware/
│       ├── config.js
│       ├── db.js
│       └── index.js
├── agent/
│   └── src/
│       ├── docker.js       # Docker Engine integration
│       ├── paths.js        # Safe host file paths
│       └── index.js        # Node API
├── eggs/index.json
├── scripts/
├── tests/
├── docker-compose.yml
└── package.json
```

### Runtime boundary

The panel does not start game processes on the web server. A node agent must run on each host with Docker Engine and access to that host's Docker socket. The panel calls the agent using a unique bearer token for the node. The agent exposes the CrazePanel server API and validates every request.

## Requirements

- Node.js 22 LTS (Node.js 22–24 supported).
- Docker Engine on every machine that will host game servers.
- Ubuntu 22.04/24.04 or Debian 12/13 recommended for production nodes.
- A reverse proxy with HTTPS for public panel access.
- A reachable IP address or DNS name for each node agent.

## Manual panel installation

```bash
git clone https://github.com/CrazeStudio/panel.git
cd panel
cp .env.example .env
```

Generate the panel encryption key and session secret:

```bash
openssl rand -hex 32
openssl rand -base64 48
```

Put the 64-character hex value in `PANEL_APP_KEY` and the second value in `SESSION_SECRET` inside `.env`. Generate a separate 64-character agent token for a single-node Compose setup:

```bash
openssl rand -hex 32
```

Set it as `NODE_TOKEN` in `.env`. For local HTTP testing, set `COOKIE_SECURE=false`. For public HTTPS deployments, keep `COOKIE_SECURE=true` and configure the proxy to forward the HTTPS scheme.

Install and start:

```bash
nvm install 22
nvm use 22
npm install
npm start
```

Open `http://localhost:3000`. The first-run screen creates the initial administrator. There are no hardcoded demo credentials.

## Install a node agent

Install Docker Engine and Node.js 22 first. Then clone the repository onto the host that will run game containers:

```bash
sudo apt-get update
sudo apt-get install -y git tar ca-certificates
git clone https://github.com/CrazeStudio/panel.git /opt/crazepanel
cd /opt/crazepanel
npm install
sudo mkdir -p /etc/crazepanel /var/lib/crazepanel/servers /var/lib/crazepanel/backups
sudo chmod 700 /etc/crazepanel /var/lib/crazepanel
```

Create a node in **Administration → Nodes** in the panel. Copy its one-time token. Create `/etc/crazepanel/agent.env`:

```bash
sudo tee /etc/crazepanel/agent.env >/dev/null <<'EOF'
NODE_TOKEN=PASTE_THE_NODE_TOKEN_HERE
AGENT_HOST=0.0.0.0
AGENT_PORT=8080
DOCKER_SOCKET=/var/run/docker.sock
SERVER_DATA_ROOT=/var/lib/crazepanel/servers
BACKUP_ROOT=/var/lib/crazepanel/backups
EGGS_FILE=/opt/crazepanel/eggs/index.json
EOF
sudo chmod 600 /etc/crazepanel/agent.env
```

Copy `scripts/crazepanel-agent.service` to `/etc/systemd/system/crazepanel-agent.service`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now crazepanel-agent
sudo systemctl status crazepanel-agent
```

Use the externally reachable agent URL (for example `https://node1.example.com:8080`) in the panel node record. Do not expose port 8080 to the public internet without TLS and network restrictions. Restrict it to the panel's source IP or a private VPN where possible.

The included `scripts/install-agent.sh` automates the agent setup after Docker and Node.js are installed. It asks for the one-time token generated by the panel.

## Production installation (recommended)

Supported targets: Ubuntu 22.04/24.04 and Debian 12/13 on a Linux server with a public IP or DNS name.

The installer installs Node.js 22 LTS and build dependencies, clones or fast-forward-updates the selected branch, creates a locked-down service account, generates strong secrets on first install, configures persistent storage, installs the systemd service, and verifies the local health endpoint. Existing `/etc/crazepanel/panel.env` and `/var/lib/crazepanel` are preserved on upgrades.

For a public panel with automatic HTTPS, point your domain's DNS A/AAAA record to the server, allow inbound TCP ports 80 and 443, then run:

```bash
sudo PANEL_DOMAIN=panel.example.com bash scripts/install-panel.sh
```

The installer configures Caddy to obtain and renew TLS certificates automatically. If you do not have a domain yet, install locally (not publicly exposed):

```bash
sudo bash scripts/install-panel.sh
```

Then configure a reverse proxy and HTTPS before publishing the panel. Do not set `COOKIE_SECURE=false` on a public deployment.

Useful operations:

```bash
sudo systemctl status crazepanel-panel
sudo journalctl -u crazepanel-panel -f
curl -fsS http://127.0.0.1:3000/api/health
```

To install a node agent on a Minecraft host, use `sudo bash scripts/install-agent.sh` after creating the node in **Administration → Nodes**. The agent installer installs Docker Engine if missing, installs Node.js 22, asks for the one-time token, and configures the systemd service. Restrict TCP 8080 to the panel host or a private VPN; never expose the Docker socket or an unauthenticated agent endpoint.

## Quick Docker Compose setup

The included compose file runs the panel and a node agent on one Docker host.

1. Generate `PANEL_APP_KEY`, `SESSION_SECRET`, and `NODE_TOKEN` with the commands above and add them to `.env`.
2. Set `COOKIE_SECURE=false` only for local testing without HTTPS.
3. Start the services:

```bash
docker compose up -d --build
```

4. Complete first-run admin setup at `http://localhost:3000`.
5. Add a node using URL `http://agent:8080`, and paste the same 64-character `NODE_TOKEN` configured in `.env` into the optional existing-token field.

The Compose file binds the same absolute server data path into the agent container and the host Docker daemon. This is required because Docker resolves bind-mount source paths on the host, not inside the agent container. Change `SERVER_DATA_ROOT_HOST` in `.env` only when you also change the agent's `SERVER_DATA_ROOT` to the matching path.

For local HTTP testing set `COOKIE_SECURE=false` in `.env`; for HTTPS deployments set it to `true` and make sure the reverse proxy forwards the original HTTPS scheme.

**Docker socket warning:** access to `/var/run/docker.sock` effectively grants host-level control. Keep the agent on a trusted server, protect its token, firewall the agent port, and do not expose the Docker socket. The current server image catalogue is allow-listed in `eggs/index.json`; this build does not accept arbitrary client-supplied Docker images.

## Panel API

All panel API writes require the signed-in session and the `X-CSRF-Token` returned by `GET /api/auth/me` or the login/setup response.

- `GET /api/health`
- `GET /api/auth/setup-status`
- `POST /api/auth/setup`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET|POST /api/nodes`
- `POST /api/nodes/:id/test`
- `DELETE /api/nodes/:id`
- `GET|POST /api/servers`
- `GET|PATCH|DELETE /api/servers/:id`
- `POST /api/servers/:id/power/:action`
- `GET|POST /api/servers/:id/console`
- `GET /api/servers/:id/files`
- `GET|PUT /api/servers/:id/file`
- `POST /api/servers/:id/files`
- `DELETE /api/servers/:id/file`
- `GET|POST /api/servers/:id/backups`
- `POST /api/servers/:id/backups/restore`
- `GET|POST /api/admin/users`
- `PATCH|DELETE /api/admin/users/:id`
- `GET /api/admin/audit`

## Node API

All node-agent endpoints require `Authorization: Bearer NODE_TOKEN`.

- `GET /api/health`
- `GET /api/servers`
- `POST /api/servers`
- `GET /api/servers/:id`
- `POST /api/servers/:id/power/:action`
- `PATCH /api/servers/:id/resources`
- `GET|POST /api/servers/:id/console`
- `GET /api/servers/:id/files`
- `GET|PUT /api/servers/:id/file`
- `POST /api/servers/:id/files`
- `DELETE /api/servers/:id/file`
- `GET|POST /api/servers/:id/backups`
- `POST /api/servers/:id/backups/restore`
- `DELETE /api/servers/:id`

## Tests and checks

```bash
npm test
node --check panel/src/index.js
node --check agent/src/index.js
```

Automated tests cover path traversal protections, the egg catalogue and node URL validation. A real container lifecycle test requires a Linux host with a running Docker Engine and a configured agent node.

## Scope and limitations

- The panel and node agent must be reachable from one another. An offline node cannot execute power, console, file or backup operations.
- The browser displays state and metrics returned by Docker through the agent; it does not invent online or CPU values.
- The current build targets Minecraft Java and Bedrock. More supported games can be added to the allow-listed egg catalogue and agent provisioning logic.
- Console input depends on interactive stdin support in the selected container image.
- File editor limit is 2 MB; file upload limit is 64 MB. Hidden files and symbolic links are blocked by the agent file API.
- Full backups use host disk space. Backups should be copied to off-node storage for disaster recovery.
- Deleting a server removes the Docker container and panel record. Its host data directory is retained; remove it manually only after verifying you no longer need the data.
- This is the first rebuilt baseline, not a claim of feature parity with mature commercial hosting panels. Advanced scheduling, file download/rename, SFTP, allocations, multi-factor authentication, automated off-site backups and billing are not included in this build.

## License

MIT. See [LICENSE](LICENSE).
