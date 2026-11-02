const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { asyncRoute, requireCsrf } = require('../middleware/auth');
const { audit } = require('../lib/audit');

function createAuthRouter(db) {
  const router = express.Router();
  const loginLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
  });

  router.get('/setup-status', (_req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    res.json({ setupRequired: count === 0 });
  });

  router.post('/setup', asyncRoute(async (req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    if (count !== 0) return res.status(409).json({ error: 'Initial setup has already been completed.' });

    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;

    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters and use letters, numbers, dots, dashes or underscores.' });
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Use a password between 12 and 128 characters.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    const createFirstAdmin = db.transaction(() => {
      const currentUsers = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
      if (currentUsers !== 0) {
        const error = new Error('Initial setup has already been completed.');
        error.code = 'SETUP_ALREADY_COMPLETED';
        throw error;
      }

      db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, email || null, hash, 'admin');
    });

    try {
      createFirstAdmin.immediate();
    } catch (error) {
      if (error.code === 'SETUP_ALREADY_COMPLETED') {
        return res.status(409).json({ error: error.message });
      }
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return res.status(409).json({ error: 'That username is already in use.' });
      }
      throw error;
    }

    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'Could not create a secure session.' });
      req.session.user = { id, username, email, role: 'admin' };
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ error: 'Could not save the session.' });
        audit(db, req, 'initial_setup', 'user', id);
        res.status(201).json({ user: req.session.user, csrfToken: req.session.csrfToken });
      });
    });
  }));

  router.post('/login', loginLimit, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = req.body?.password;
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);

    if (!user || user.disabled || typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'The username or password is incorrect.' });
    }

    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'Could not create a secure session.' });
      req.session.user = { id: user.id, username: user.username, email: user.email, role: user.role };
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ error: 'Could not save the session.' });
        audit(db, req, 'login', 'user', user.id);
        res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
      });
    });
  }));

  router.get('/me', (req, res) => {
    res.json({ user: req.session?.user || null, csrfToken: req.session?.csrfToken || null });
  });

  router.post('/logout', requireCsrf, (req, res) => {
    const userId = req.session?.user?.id;
    if (userId) audit(db, req, 'logout', 'user', userId);
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ error: 'Could not end the session.' });
      res.clearCookie('crazepanel.sid');
      res.json({ ok: true });
    });
  });

  return router;
}

module.exports = { createAuthRouter };
