const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const port = Number(process.env.PORT || 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  if (!process.env.PANEL_APP_KEY) {
    throw new Error('PANEL_APP_KEY is required. Generate one with: openssl rand -hex 32');
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters.');
  }

  return {
    root: ROOT,
    dataDir,
    databasePath: path.join(dataDir, 'panel.sqlite'),
    publicDir: path.join(__dirname, '..', 'public'),
    host: process.env.HOST || '0.0.0.0',
    port,
    trustProxy: process.env.TRUST_PROXY === '1',
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
    sessionSecret: process.env.SESSION_SECRET,
    production: process.env.NODE_ENV === 'production',
  };
}

module.exports = { loadConfig };
