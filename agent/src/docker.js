const Docker = require('dockerode');

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const consoleStreams = new Map();

function followPull(stream) {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error, output) => error ? reject(error) : resolve(output));
  });
}

async function ensureImage(image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    const stream = await docker.pull(image);
    await followPull(stream);
  }
}

async function attachConsole(container, serverId) {
  try {
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      logs: false,
    });

    const entry = { stream, lines: [], connectedAt: new Date().toISOString() };
    stream.on('data', (chunk) => {
      const text = chunk.toString('utf8').replace(/\u0000/g, '');
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        entry.lines.push({ line: line.slice(0, 4000), at: new Date().toISOString() });
      }
      if (entry.lines.length > 500) entry.lines.splice(0, entry.lines.length - 500);
    });
    stream.on('error', () => console.warn(`Console stream closed for ${serverId}`));
    stream.on('close', () => {
      if (consoleStreams.get(serverId) === entry) consoleStreams.delete(serverId);
    });
    consoleStreams.set(serverId, entry);
    return entry;
  } catch (error) {
    console.warn(`Could not attach console for ${serverId}: ${error.message}`);
    return null;
  }
}

async function getContainer(serverId) {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`io.crazepanel.server-id=${serverId}`] },
  });
  if (!containers.length) return null;
  return docker.getContainer(containers[0].Id);
}

function normalizeState(state) {
  if (state === 'running') return 'running';
  if (state === 'created') return 'installing';
  if (state === 'restarting') return 'restarting';
  if (state === 'paused' || state === 'exited' || state === 'dead') return 'stopped';
  return 'unknown';
}

async function inspectServer(serverId) {
  const container = await getContainer(serverId);
  if (!container) return { exists: false, status: 'missing' };
  const info = await container.inspect();
  return {
    exists: true,
    containerId: info.Id,
    status: normalizeState(info.State.Status),
    state: info.State,
    startedAt: info.State.StartedAt,
    finishedAt: info.State.FinishedAt,
  };
}

async function createServer(options) {
  await ensureImage(options.image);
  const exposed = { [options.containerPort]: {} };
  const portBindings = {
    [options.containerPort]: [{ HostIp: '0.0.0.0', HostPort: String(options.port) }],
  };

  const container = await docker.createContainer({
    Image: options.image,
    name: `craze-${options.serverId.replace(/-/g, '').slice(0, 20)}`,
    Env: options.env,
    ExposedPorts: exposed,
    Labels: {
      'io.crazepanel.managed': 'true',
      'io.crazepanel.server-id': options.serverId,
      'io.crazepanel.egg-id': options.eggId,
    },
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    HostConfig: {
      Binds: [`${options.directory}:/data`],
      PortBindings: portBindings,
      Memory: options.memoryMb * 1024 * 1024,
      NanoCpus: Math.floor(options.cpuCores * 1e9),
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
    },
  });

  await attachConsole(container, options.serverId);
  try {
    await container.start();
  } catch (error) {
    await container.remove({ force: true }).catch(() => {});
    throw error;
  }

  return { containerId: container.id, status: 'running' };
}

async function powerServer(serverId, action) {
  const container = await getContainer(serverId);
  if (!container) throw new Error('Managed container not found.');

  if (action === 'start') {
    const info = await container.inspect();
    if (info.State.Running) return { status: 'running' };
    await attachConsole(container, serverId);
    await container.start();
  } else if (action === 'stop') {
    await container.stop({ t: 30 });
    consoleStreams.delete(serverId);
  } else if (action === 'restart') {
    await container.restart({ t: 30 });
    await attachConsole(container, serverId);
  } else if (action === 'kill') {
    await container.kill();
    consoleStreams.delete(serverId);
  } else {
    throw new Error('Unsupported power action.');
  }

  const state = await inspectServer(serverId);
  return { status: state.status };
}

async function getConsole(serverId) {
  const container = await getContainer(serverId);
  if (!container) throw new Error('Managed container not found.');
  const logs = await container.logs({ stdout: true, stderr: true, tail: 250, timestamps: true });
  const output = Buffer.isBuffer(logs) ? logs.toString('utf8') : String(logs);
  return {
    lines: output.split(/\r?\n/).filter(Boolean).slice(-250),
    attached: consoleStreams.has(serverId),
  };
}

async function sendCommand(serverId, command) {
  const entry = consoleStreams.get(serverId);
  if (!entry || entry.stream.destroyed) {
    throw new Error('Console input is not attached. Restart the server to reconnect its console.');
  }
  entry.stream.write(command + '\n');
  return { ok: true };
}

async function getStats(serverId) {
  const container = await getContainer(serverId);
  if (!container) throw new Error('Managed container not found.');
  const stats = await container.stats({ stream: false });
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const cpus = stats.cpu_stats?.online_cpus || 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0;
  const memoryUsage = stats.memory_stats?.usage || 0;
  const memoryLimit = stats.memory_stats?.limit || 0;
  const networks = Object.values(stats.networks || {});

  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memoryBytes: memoryUsage,
    memoryLimitBytes: memoryLimit,
    memoryPercent: memoryLimit ? Number((memoryUsage / memoryLimit * 100).toFixed(2)) : 0,
    networkRxBytes: networks.reduce((sum, item) => sum + (item.rx_bytes || 0), 0),
    networkTxBytes: networks.reduce((sum, item) => sum + (item.tx_bytes || 0), 0),
  };
}

async function updateResources(serverId, memoryMb, cpuCores) {
  const container = await getContainer(serverId);
  if (!container) throw new Error('Managed container not found.');
  await container.update({
    Memory: memoryMb * 1024 * 1024,
    NanoCpus: Math.floor(cpuCores * 1e9),
  });
  return { ok: true };
}

async function deleteServer(serverId) {
  const container = await getContainer(serverId);
  if (!container) return { ok: true, alreadyMissing: true };
  consoleStreams.delete(serverId);
  const info = await container.inspect();
  if (info.State.Running) await container.stop({ t: 15 }).catch(() => {});
  await container.remove({ force: true, v: false });
  return { ok: true };
}

async function reconnectExistingConsoles() {
  const containers = await docker.listContainers({
    all: false,
    filters: { label: ['io.crazepanel.managed=true'] },
  });
  for (const item of containers) {
    const serverId = item.Labels?.['io.crazepanel.server-id'];
    if (serverId) await attachConsole(docker.getContainer(item.Id), serverId);
  }
}

module.exports = {
  docker,
  getContainer,
  inspectServer,
  createServer,
  powerServer,
  getConsole,
  sendCommand,
  getStats,
  updateResources,
  deleteServer,
  reconnectExistingConsoles,
};
