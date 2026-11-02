const express = require('express');
const crypto = require('node:crypto');
const { requireAdmin, asyncRoute } = require('../middleware/auth');
const { encryptSecret, randomToken } = require('../lib/crypto');
const { agentRequest } = require('../lib/agent-client');
const { audit } = require('../lib/audit');

function validateNodeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function createNodesRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', asyncRoute(async (_req, res) => {
    const nodes = db.prepare('SELECT id, name, url, location, last_seen, created_at FROM nodes ORDER BY created_at DESC').all();
    const results = await Promise.all(nodes.map(async (node) => {
      try {
        const health = await agentRequest(db, node.id, '/api/health', { timeout: 5000 });
        return { ...node, online: true, agentVersion: health.agentVersion, docker: health.docker };
      } catch (error) {
        return { ...node, online: false, error: error.message };
      }
    }));
    res.json({ nodes: results });
  }));

  router.post('/', asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const location = String(req.body?.location || '').trim().slice(0, 80);
    const url = validateNodeUrl(String(req.body?.url || '').trim());
    if (!name || name.length > 64 || !url) {
      return res.status(400).json({ error: 'Provide a node name and a valid base URL (for example https://node.example.com:8080).' });
    }

    const id = crypto.randomUUID();
    const token = randomToken();
    const encrypted = encryptSecret(token);
    db.prepare(`
      INSERT INTO nodes (id, name, url, location, token_cipher, token_iv, token_tag)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, url, location, encrypted.cipher, encrypted.iv, encrypted.tag);

    audit(db, req, 'node_created', 'node', id, { name, url });
    res.status(201).json({
      node: { id, name, url, location, online: false },
      token,
      agentSetup: { NODE_TOKEN: token, AGENT_HOST: '0.0.0.0', AGENT_PORT: '8080' },
    });
  }));

  router.post('/:id/test', asyncRoute(async (req, res) => {
    const health = await agentRequest(db, req.params.id, '/api/health', { timeout: 8000 });
    res.json({ ok: true, health });
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS total FROM servers WHERE node_id = ?').get(req.params.id).total;
    if (count > 0) return res.status(409).json({ error: 'Move or delete this node’s servers before removing the node.' });

    const result = db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Node not found.' });
    audit(db, req, 'node_deleted', 'node', req.params.id);
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createNodesRouter, validateNodeUrl };
