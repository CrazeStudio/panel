const express = require('express');
const crypto = require('node:crypto');
const eggs = require('../lib/eggs');
const { requireAdmin, asyncRoute } = require('../middleware/auth');
const { agentRequest } = require('../lib/agent-client');
const { audit } = require('../lib/audit');

function permissionFor(db, server, user) {
  if (user.role === 'admin' || server.owner_id === user.id) return 'admin';
  return db.prepare('SELECT permission FROM server_users WHERE server_id = ? AND user_id = ?')
    .get(server.id, user.id)?.permission || null;
}

function canAccess(db, server, user) {
  return Boolean(permissionFor(db, server, user));
}

function canOperate(db, server, user) {
  const permission = permissionFor(db, server, user);
  return permission === 'admin' || permission === 'operator';
}

function visibleServer(db, server, user) {
  const { owner_id, ...publicData } = server;
  const permission = permissionFor(db, server, user);
  return {
    ...publicData,
    canManage: user.role === 'admin' || owner_id === user.id,
    canOperate: permission === 'admin' || permission === 'operator',
    accessPermission: permission,
  };
}

function getServer(db, id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function createServersRouter(db) {
  const router = express.Router();

  router.get('/', asyncRoute(async (req, res) => {
    const rows = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    const allowed = rows.filter((server) => canAccess(db, server, req.session.user));

    const servers = await Promise.all(allowed.map(async (server) => {
      try {
        const live = await agentRequest(db, server.node_id, `/api/servers/${server.id}`, { timeout: 5000 });
        db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(live.status, server.id);
        return visibleServer(db, { ...server, status: live.status }, req.session.user);
      } catch (error) {
        return visibleServer(db, { ...server, status: 'node-offline', agentError: error.message }, req.session.user);
      }
    }));

    res.json({ servers });
  }));

  router.post('/', requireAdmin, asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const eggId = String(req.body?.eggId || '');
    const version = String(req.body?.version || 'LATEST').trim();
    const nodeId = String(req.body?.nodeId || '');
    const memoryMb = Number(req.body?.memoryMb || 4096);
    const cpuCores = Number(req.body?.cpuCores || 2);
    const port = Number(req.body?.port || 25565);

    if (req.body?.eulaAccepted !== true) {
      return res.status(400).json({ error: 'Confirm that you agree to the Minecraft EULA before creating a server.' });
    }

    if (!name || name.length > 48 || !eggs[eggId] || !nodeId) {
      return res.status(400).json({ error: 'Choose a server name, a supported egg and a node.' });
    }
    if (!/^[a-zA-Z0-9._-]{1,20}$/.test(version)) {
      return res.status(400).json({ error: 'Version must contain only letters, numbers, dots, underscores or dashes.' });
    }
    if (!Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 131072 ||
        !Number.isFinite(cpuCores) || cpuCores < 0.5 || cpuCores > 64 ||
        !Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'Check the memory, CPU and host port values.' });
    }

    const node = db.prepare('SELECT id FROM nodes WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    const id = crypto.randomUUID();
    const provisioned = await agentRequest(db, nodeId, '/api/servers', {
      method: 'POST',
      timeout: 120000,
      body: { serverId: id, name, eggId, version, memoryMb, cpuCores, port },
    });

    db.prepare(`
      INSERT INTO servers
        (id, owner_id, node_id, name, egg_id, version, memory_mb, cpu_cores, port, container_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.session.user.id, nodeId, name, eggId, version,
      memoryMb, cpuCores, port, provisioned.containerId, provisioned.status || 'running'
    );

    audit(db, req, 'server_created', 'server', id, { name, eggId, nodeId, port });
    res.status(201).json({ server: getServer(db, id) });
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });

    const [live, node] = await Promise.all([
      agentRequest(db, server.node_id, `/api/servers/${server.id}`),
      Promise.resolve(db.prepare('SELECT id, name, location, url FROM nodes WHERE id = ?').get(server.node_id)),
    ]);

    res.json({ server: visibleServer(db, { ...server, status: live.status }, req.session.user), live, node });
  }));

  router.get('/:id/users', requireAdmin, (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    const users = db.prepare('SELECT id, username, email, role, disabled FROM users WHERE id != ? ORDER BY username').all(server.owner_id);
    const assignments = db.prepare('SELECT user_id, permission FROM server_users WHERE server_id = ?').all(server.id);
    res.json({ users, assignments });
  });

  router.post('/:id/users', requireAdmin, (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    const userId = String(req.body?.userId || '');
    const permission = req.body?.permission;
    if (!['operator', 'read'].includes(permission)) return res.status(400).json({ error: 'Permission must be operator or read.' });
    const user = db.prepare('SELECT id, disabled FROM users WHERE id = ?').get(userId);
    if (!user || user.disabled) return res.status(404).json({ error: 'Active panel user not found.' });
    if (user.id === server.owner_id) return res.status(409).json({ error: 'The server owner already has full access.' });
    db.prepare('INSERT INTO server_users (server_id, user_id, permission) VALUES (?, ?, ?) ON CONFLICT(server_id, user_id) DO UPDATE SET permission = excluded.permission')
      .run(server.id, userId, permission);
    audit(db, req, 'server_access_granted', 'server', server.id, { userId, permission });
    res.json({ ok: true });
  });

  router.delete('/:id/users/:userId', requireAdmin, (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    const result = db.prepare('DELETE FROM server_users WHERE server_id = ? AND user_id = ?').run(server.id, req.params.userId);
    if (!result.changes) return res.status(404).json({ error: 'Server access assignment not found.' });
    audit(db, req, 'server_access_revoked', 'server', server.id, { userId: req.params.userId });
    res.json({ ok: true });
  });
  router.patch('/:id', requireAdmin, asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    const memoryMb = req.body?.memoryMb === undefined ? server.memory_mb : Number(req.body.memoryMb);
    const cpuCores = req.body?.cpuCores === undefined ? server.cpu_cores : Number(req.body.cpuCores);

    if (!Number.isInteger(memoryMb) || memoryMb < 1024 || memoryMb > 131072 ||
        !Number.isFinite(cpuCores) || cpuCores < 0.5 || cpuCores > 64) {
      return res.status(400).json({ error: 'Invalid resource limits.' });
    }

    await agentRequest(db, server.node_id, `/api/servers/${server.id}/resources`, {
      method: 'PATCH',
      body: { memoryMb, cpuCores },
    });
    db.prepare('UPDATE servers SET memory_mb = ?, cpu_cores = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(memoryMb, cpuCores, server.id);
    audit(db, req, 'server_resources_updated', 'server', server.id, { memoryMb, cpuCores });
    res.json({ server: getServer(db, server.id) });
  }));

  router.delete('/:id', requireAdmin, asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });

    await agentRequest(db, server.node_id, `/api/servers/${server.id}`, {
      method: 'DELETE',
      timeout: 30000,
    });
    db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);
    audit(db, req, 'server_deleted', 'server', server.id, { name: server.name });
    res.json({ ok: true });
  }));

  router.post('/:id/power/:action', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required for power actions.' });

    const action = req.params.action;
    if (!['start', 'stop', 'restart', 'kill'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported power action.' });
    }

    const result = await agentRequest(db, server.node_id, `/api/servers/${server.id}/power/${action}`, {
      method: 'POST',
      timeout: 30000,
    });
    db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(result.status || action, server.id);
    audit(db, req, `server_${action}`, 'server', server.id);
    res.json(result);
  }));

  router.get('/:id/console', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/console`));
  }));

  router.post('/:id/console', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to send console commands.' });
    const command = String(req.body?.command || '').trim();
    if (!command || command.length > 500) return res.status(400).json({ error: 'Enter a command under 500 characters.' });
    const result = await agentRequest(db, server.node_id, `/api/servers/${server.id}/console`, {
      method: 'POST',
      body: { command },
    });
    audit(db, req, 'server_console_command', 'server', server.id, { command: command.slice(0, 120) });
    res.json(result);
  }));

  router.get('/:id/files', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });
    const query = new URLSearchParams({ path: String(req.query.path || '') });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/files?${query}`));
  }));

  router.get('/:id/download', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });
    const query = new URLSearchParams({ path: String(req.query.path || '') });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/download?${query}`));
  }));
  router.get('/:id/file', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });
    const query = new URLSearchParams({ path: String(req.query.path || '') });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/file?${query}`));
  }));

  router.put('/:id/file', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to edit files.' });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/file`, {
      method: 'PUT',
      body: { path: req.body?.path, content: req.body?.content },
    }));
  }));

  router.post('/:id/files', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to modify files.' });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/files`, {
      method: 'POST',
      body: req.body,
      timeout: 60000,
    }));
  }));

  router.delete('/:id/file', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to delete files.' });
    const query = new URLSearchParams({ path: String(req.query.path || '') });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/file?${query}`, { method: 'DELETE' }));
  }));

  router.get('/:id/backups', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canAccess(db, server, req.session.user)) return res.status(403).json({ error: 'You do not have access to this server.' });
    res.json(await agentRequest(db, server.node_id, `/api/servers/${server.id}/backups`));
  }));

  router.post('/:id/backups', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to create backups.' });
    const result = await agentRequest(db, server.node_id, `/api/servers/${server.id}/backups`, {
      method: 'POST',
      timeout: 120000,
      body: { label: String(req.body?.label || 'Manual backup').slice(0, 80) },
    });
    audit(db, req, 'server_backup_created', 'server', server.id, { backup: result.name });
    res.status(201).json(result);
  }));

  router.post('/:id/backups/restore', asyncRoute(async (req, res) => {
    const server = getServer(db, req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found.' });
    if (!canOperate(db, server, req.session.user)) return res.status(403).json({ error: 'Operator permission is required to restore backups.' });
    const name = String(req.body?.name || '');
    const result = await agentRequest(db, server.node_id, `/api/servers/${server.id}/backups/restore`, {
      method: 'POST',
      timeout: 120000,
      body: { name },
    });
    audit(db, req, 'server_backup_restored', 'server', server.id, { backup: name });
    res.json(result);
  }));

  return router;
}

module.exports = { createServersRouter, canAccess };
