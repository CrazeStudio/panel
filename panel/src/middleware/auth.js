function requireAuth(db) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Sign in is required.' });

    const user = db.prepare('SELECT id, username, email, role, disabled FROM users WHERE id = ?')
      .get(req.session.user.id);

    if (!user || user.disabled) {
      return req.session.destroy(() => res.status(401).json({ error: 'This account is disabled or no longer exists.' }));
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
    };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Sign in is required.' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access is required.' });
  next();
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const expected = req.session?.csrfToken;
  const supplied = req.get('x-csrf-token');

  if (!expected || !supplied || expected.length !== supplied.length) {
    return res.status(403).json({ error: 'Invalid security token. Refresh and try again.' });
  }

  const crypto = require('node:crypto');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return res.status(403).json({ error: 'Invalid security token. Refresh and try again.' });
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { requireAuth, requireAdmin, requireCsrf, asyncRoute };
