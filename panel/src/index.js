require('dotenv').config({ path: process.env.ENV_FILE || '.env' });

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { requireAuth, requireCsrf } = require('./middleware/auth');
const { createAuthRouter } = require('./routes/auth');
const { createNodesRouter } = require('./routes/nodes');
const { createServersRouter } = require('./routes/servers');
const { createAdminRouter } = require('./routes/admin');

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const db = openDatabase(config.databasePath);
const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '70mb' }));
app.use(session({
  name: 'crazepanel.sid',
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: config.dataDir, concurrentDB: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'crazepanel', version: '2.0.0', time: new Date().toISOString() });
});

app.use('/api/auth', createAuthRouter(db));
app.use('/api', requireAuth, requireCsrf);
app.use('/api/nodes', createNodesRouter(db));
app.use('/api/servers', createServersRouter(db));
app.use('/api/admin', createAdminRouter(db));

app.get('/api/eggs', (_req, res) => {
  res.json({ eggs: require('../../eggs/index.json') });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(config.publicDir, {
  extensions: ['html'],
  etag: true,
  maxAge: config.production ? '1h' : 0,
}));
app.get('*', (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));

app.use((error, _req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status >= 500 && config.production ? 'An internal panel error occurred.' : error.message,
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`CrazePanel 2.0 listening on http://${config.host}:${config.port}`);
  console.log(`Persistent data: ${config.dataDir}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; closing panel.`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
