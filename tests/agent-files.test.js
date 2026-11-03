const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('agent HTTP file and backup download routes work without a Docker host', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'crazepanel-agent-api-'));
  const dataRoot = path.join(temporary, 'servers');
  const backupRoot = path.join(temporary, 'backups');
  const serverId = '123e4567-e89b-12d3-a456-426614174000';
  await fs.mkdir(path.join(dataRoot, serverId), { recursive: true });
  await fs.mkdir(path.join(backupRoot, serverId), { recursive: true });
  await fs.writeFile(path.join(temporary, 'empty.env'), '');

  const port = await unusedPort();
  const token = crypto.randomBytes(32).toString('hex');
  const repositoryRoot = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(repositoryRoot, 'agent/src/index.js')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ENV_FILE: path.join(temporary, 'empty.env'),
      NODE_TOKEN: token,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      SERVER_DATA_ROOT: dataRoot,
      BACKUP_ROOT: backupRoot,
      DOCKER_SOCKET: path.join(temporary, 'no-docker.sock'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(3000),
      ]);
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  async function request(route, { method = 'GET', body, auth = token } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    return { response, payload };
  }

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Agent exited before readiness. Output: ${output}`);
    try {
      const result = await request(`/api/servers/${serverId}/files`);
      if (result.response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.equal(ready, true, `Agent did not become ready. Output: ${output}`);

  const unauthenticated = await request(`/api/servers/${serverId}/files`, { auth: 'invalid-token' });
  assert.equal(unauthenticated.response.status, 401);

  const created = await request(`/api/servers/${serverId}/files`, {
    method: 'POST', body: { action: 'create', path: 'server.properties', content: 'motd=first' },
  });
  assert.equal(created.response.status, 201);
  const duplicate = await request(`/api/servers/${serverId}/files`, {
    method: 'POST', body: { action: 'create', path: 'server.properties', content: 'motd=destroyed' },
  });
  assert.equal(duplicate.response.status, 409);
  const unchanged = await request(`/api/servers/${serverId}/file?path=server.properties`);
  assert.equal(unchanged.payload.content, 'motd=first');

  const saved = await request(`/api/servers/${serverId}/file`, {
    method: 'PUT', body: { path: 'server.properties', content: 'motd=updated' },
  });
  assert.equal(saved.response.status, 200);
  const read = await request(`/api/servers/${serverId}/file?path=server.properties`);
  assert.equal(read.payload.content, 'motd=updated');

  const folder = await request(`/api/servers/${serverId}/files`, {
    method: 'POST', body: { action: 'mkdir', path: 'plugins' },
  });
  assert.equal(folder.response.status, 201);
  const uploadBytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const upload = await request(`/api/servers/${serverId}/files`, {
    method: 'POST', body: { action: 'upload', path: 'plugins', name: 'binary.dat', contentBase64: uploadBytes.toString('base64') },
  });
  assert.equal(upload.response.status, 201);
  const download = await request(`/api/servers/${serverId}/download?path=plugins%2Fbinary.dat`);
  assert.equal(download.response.status, 200);
  assert.deepEqual(Buffer.from(download.payload.contentBase64, 'base64'), uploadBytes);

  const renamed = await request(`/api/servers/${serverId}/files`, {
    method: 'POST', body: { action: 'rename', sourcePath: 'plugins/binary.dat', name: 'renamed.dat' },
  });
  assert.equal(renamed.response.status, 200);
  const removed = await request(`/api/servers/${serverId}/file?path=plugins%2Frenamed.dat`, { method: 'DELETE' });
  assert.equal(removed.response.status, 200);
  const listing = await request(`/api/servers/${serverId}/files?path=plugins`);
  assert.deepEqual(listing.payload.files, []);

  await fs.writeFile(path.join(backupRoot, serverId, 'manual.tar.gz'), 'test archive');
  const backupList = await request(`/api/servers/${serverId}/backups`);
  assert.equal(backupList.response.status, 200);
  assert.equal(backupList.payload.backups[0].name, 'manual.tar.gz');
  const backupDownload = await request(`/api/servers/${serverId}/backups/manual.tar.gz/download`);
  assert.equal(backupDownload.response.status, 200);
  assert.equal(Buffer.from(backupDownload.payload.contentBase64, 'base64').toString(), 'test archive');

  const traversal = await request(`/api/servers/${serverId}/file?path=..%2Foutside`);
  assert.equal(traversal.response.status, 400);
});
