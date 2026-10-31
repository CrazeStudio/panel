# BlockPanel

A self-hosted control panel for local Minecraft Java Edition server processes. Node.js and SQLite power the panel; Java runs each configured server jar in its own managed directory.

## Requirements

- Node.js 20 or newer
- Java installed on the host (Java version depends on the Minecraft server version)
- A Minecraft Java server jar, such as Paper or the official server jar

## Run

```sh
npm install
npm start
```

Open `http://localhost:3000` and create the first admin account. Use a password with at least 12 characters. The panel creates `data/panel.sqlite`, `data/sessions.sqlite`, and one `data/servers/server-<id>/` directory for each instance.

If Java is not on `PATH`, set its executable before starting the panel:

```sh
JAVA_BIN=/path/to/java npm start
```

Set `PORT` to change the web port. `DATA_DIR` changes where the database, session store, session secret, and server directories are kept. When deploying behind HTTPS, set `NODE_ENV=production`; configure the reverse proxy to forward the original protocol and restrict access to the panel.

## Add a server

1. In the panel, choose **Add server** and set its jar filename, memory range, and game port.
2. Copy the corresponding Minecraft server jar into the generated server directory shown in the instance details. The default filename is `server.jar`.
3. Start the instance. On its first launch, accept Mojang's EULA by editing that instance's `eula.txt` and setting `eula=true`, then start it again.
4. Allow the selected game port through the host firewall if players will connect over the network.

Each Java process receives only the panel's fixed memory arguments and the configured jar path; arbitrary shell commands are not used. The console sends commands to the Minecraft process stdin. The panel stores the most recent 500 console lines per instance.

## Security and operations

- The first account is the only panel account; protect it with a unique password.
- Keep the panel on a trusted network or put it behind HTTPS and an access controlled reverse proxy before exposing it publicly.
- Back up the full `data/` directory while the panel is stopped to preserve settings, credentials, sessions, and server files.
- Deleting an instance removes its database entry and console history. It intentionally leaves the server directory on disk.
- The panel manages local Java processes and reports their state only while it is running. A Java server already running before the panel starts is not reattached automatically.

## Panel features

- Secure first-admin setup, sign-in, CSRF protection, and SQLite-backed sessions
- Multiple managed Java instances with start, graceful stop, restart, memory and port settings
- Live process console with command input and bounded console history
- Per-instance file browser with upload (64 MB maximum), download, delete, and text editing (1 MB maximum)
- Local per-instance filesystem backups, with restore available only while the instance is stopped

Backups are full directory copies stored under `data/backups/`; they can use substantial disk space. Stop a server before creating a snapshot for a consistent world save. File management intentionally hides dotfiles and blocks symbolic links and parent-directory traversal.
