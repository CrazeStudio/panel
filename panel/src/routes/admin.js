const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { requireAdmin, asyncRoute } = require('../middleware/auth');
const { audit } = require('../lib/audit');

function createAdminRouter(db) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/users', (_req, res) => {
    const users = db.prepare('SELECT id, username, email, role, disabled, created_at FROM users ORDER BY created_at DESC').all();
    res.json({ users });
  });

  router.post('/users', asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    const role = req.body?.role === 'admin' ? 'admin' : 'user';

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Use a valid username and a password of at least 12 characters.' });
    }

    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    try {
      db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, email || null, hash, role);
    } catch {
      return res.status(409).json({ error: 'That username is already in use.' });
    }

    audit(db, req, 'user_created', 'user', id, { username, role });
    res.status(201).json({ user: { id, username, email, role } });
  }));

  router.patch('/users/:id', (req, res) => {
    const target = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const role = req.body?.role;
    const disabled = req.body?.disabled;
    if (role !== undefined && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or user.' });
    }
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return res.status(400).json({ error: 'Disabled must be a boolean.' });
    }
    if (target.id === req.session.user.id && (role === 'user' || disabled === true)) {
      return res.status(400).json({ error: 'You cannot remove your own administrator access or disable your own account.' });
    }

    if (target.role === 'admin' && role === 'user') {
      const admins = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND disabled = 0").get().total;
      if (admins <= 1) return res.status(409).json({ error: 'At least one active administrator must remain.' });
    }

    db.prepare('UPDATE users SET role = COALESCE(?, role), disabled = COALESCE(?, disabled) WHERE id = ?')
      .run(role ?? null, disabled === undefined ? null : Number(disabled), target.id);
    audit(db, req, 'user_updated', 'user', target.id, { role, disabled });
    res.json({ ok: true });
  });

  router.delete('/users/:id', (req, res) => {
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (target.id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

    if (target.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND disabled = 0").get().total;
      if (admins <= 1) return res.status(409).json({ error: 'At least one active administrator must remain.' });
    }

    const ownedServers = db.prepare('SELECT COUNT(*) AS total FROM servers WHERE owner_id = ?').get(target.id).total;
    if (ownedServers > 0) {
      return res.status(409).json({ error: 'This user owns server instances. Reassign or delete those servers before deleting the account.' });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    audit(db, req, 'user_deleted', 'user', target.id);
    res.json({ ok: true });
  });

  router.get('/audit', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ logs });
  });

  return router;
}

module.exports = { createAdminRouter };
