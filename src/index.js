const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const crypto = require('crypto');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SERVERS_DIR = path.join(DATA, 'servers');
const BACKUPS_DIR = path.join(DATA, 'backups');
fs.mkdirSync(SERVERS_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });
const db = new Database(path.join(DATA, 'panel.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL UNIQUE, jar TEXT NOT NULL DEFAULT 'server.jar', min_memory INTEGER NOT NULL DEFAULT 1024, max_memory INTEGER NOT NULL DEFAULT 2048, port INTEGER NOT NULL DEFAULT 25565, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS console_lines (id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE, label TEXT NOT NULL, directory TEXT NOT NULL UNIQUE, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], scriptSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] } } }));
app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA }),
  secret: process.env.SESSION_SECRET || (() => { const p = path.join(DATA, 'session-secret'); if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(48), { mode: 0o600 }); return fs.readFileSync(p, 'utf8'); })(),
  resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(express.static(path.join(ROOT, 'public')));

const processes = new Map();
const insertLine = db.prepare('INSERT INTO console_lines (server_id, line) VALUES (?, ?)');
function logLine(id, line) {
  const clean = String(line).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, 2000);
  insertLine.run(id, clean);
  db.prepare('DELETE FROM console_lines WHERE server_id = ? AND id NOT IN (SELECT id FROM console_lines WHERE server_id = ? ORDER BY id DESC LIMIT 500)').run(id, id);
}
function serverDir(server) {
  const dir = path.resolve(SERVERS_DIR, server.directory);
  if (!dir.startsWith(SERVERS_DIR + path.sep)) throw new Error('Invalid server directory');
  return dir;
}
function publicServer(s) {
  const p = processes.get(s.id);
  return { id: s.id, name: s.name, directory: s.directory, jar: s.jar, minMemory: s.min_memory, maxMemory: s.max_memory, port: s.port, status: p && p.child.exitCode === null ? 'online' : 'offline', pid: p && p.child.exitCode === null ? p.child.pid : null, players: p?.players || '—', startedAt: p?.startedAt || null };
}
function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ error: 'Sign in required' }); next(); }
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  if (!req.session.csrf || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Invalid security token' });
  next();
}
app.use('/api', (req, res, next) => req.path === '/setup' || req.path === '/login' || req.path === '/me' ? next() : requireAuth(req, res, () => requireCsrf(req, res, next)));

app.get('/api/setup', (_req, res) => res.json({ needed: db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 }));
app.post('/api/setup', async (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n !== 0) return res.status(409).json({ error: 'Setup is already complete' });
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username || '') || typeof password !== 'string' || password.length < 12 || password.length > 128) return res.status(400).json({ error: 'Use a 3–32 character username and a password of at least 12 characters.' });
  const hash = await bcrypt.hash(password, 12);
  try { db.prepare('INSERT INTO users (username,password_hash) VALUES (?,?)').run(username, hash); }
  catch { return res.status(409).json({ error: 'That username is unavailable.' }); }
  req.session.regenerate(err => { if (err) return res.status(500).json({ error: 'Could not create session' }); req.session.user = { username }; req.session.csrf = crypto.randomBytes(32).toString('hex'); res.json({ user: req.session.user, csrf: req.session.csrf }); });
});
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Incorrect username or password' });
  req.session.regenerate(err => { if (err) return res.status(500).json({ error: 'Could not create session' }); req.session.user = { username: user.username }; req.session.csrf = crypto.randomBytes(32).toString('hex'); res.json({ user: req.session.user, csrf: req.session.csrf }); });
});
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null, csrf: req.session.csrf || null, setupNeeded: db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0 }));
app.post('/api/logout', requireAuth, (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/servers', requireAuth, (_req, res) => res.json(db.prepare('SELECT * FROM servers ORDER BY id DESC').all().map(publicServer)));
app.post('/api/servers', requireAuth, (req, res) => {
  let { name, jar = 'server.jar', minMemory = 1024, maxMemory = 2048, port = 25565 } = req.body || {};
  name = typeof name === 'string' ? name.trim() : ''; jar = typeof jar === 'string' ? jar.trim() : '';
  minMemory = Number(minMemory); maxMemory = Number(maxMemory); port = Number(port);
  if (!name || name.length > 48 || !/^[\w.-]+\.jar$/i.test(jar) || !Number.isInteger(minMemory) || !Number.isInteger(maxMemory) || minMemory < 256 || maxMemory < minMemory || maxMemory > 131072 || !Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Check the server name, jar filename, memory and port values.' });
  const directory = `server-${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.join(SERVERS_DIR, directory), { mode: 0o700 });
  const info = db.prepare('INSERT INTO servers (name,directory,jar,min_memory,max_memory,port) VALUES (?,?,?,?,?,?)').run(name, directory, jar, minMemory, maxMemory, port);
  res.status(201).json(publicServer(db.prepare('SELECT * FROM servers WHERE id=?').get(info.lastInsertRowid)));
});
app.patch('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (processes.has(s.id) && processes.get(s.id).child.exitCode === null) return res.status(409).json({ error: 'Stop the server before changing its settings.' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : s.name;
  const jar = typeof req.body.jar === 'string' ? req.body.jar.trim() : s.jar;
  const min = req.body.minMemory === undefined ? s.min_memory : Number(req.body.minMemory);
  const max = req.body.maxMemory === undefined ? s.max_memory : Number(req.body.maxMemory);
  const port = req.body.port === undefined ? s.port : Number(req.body.port);
  if (!name || name.length > 48 || !/^[\w.-]+\.jar$/i.test(jar) || !Number.isInteger(min) || !Number.isInteger(max) || min < 256 || max < min || max > 131072 || !Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Invalid server settings' });
  db.prepare('UPDATE servers SET name=?,jar=?,min_memory=?,max_memory=?,port=? WHERE id=?').run(name, jar, min, max, port, s.id);
  res.json(publicServer(db.prepare('SELECT * FROM servers WHERE id=?').get(s.id)));
});
app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id), s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (processes.has(id) && processes.get(id).child.exitCode === null) return res.status(409).json({ error: 'Stop the server before deleting it.' });
  db.prepare('DELETE FROM servers WHERE id=?').run(id); res.json({ ok: true });
});
app.post('/api/servers/:id/:action', requireAuth, (req, res) => {
  const id = Number(req.params.id), server = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const action = req.params.action;
  if (action === 'start' || action === 'restart') {
    const existing = processes.get(id);
    if (existing && existing.child.exitCode === null) {
      if (action === 'start') return res.status(409).json({ error: 'Server is already running' });
      existing.child.stdin.write('stop\n');
      setTimeout(() => { if (existing.child.exitCode === null) existing.child.kill('SIGTERM'); }, 15000).unref();
      existing.child.once('close', () => setTimeout(() => startServer(id), 1000));
      return res.status(202).json({ message: 'Restart requested' });
    }
    try { startServer(id); } catch (e) { return res.status(400).json({ error: e.message }); }
    return res.status(202).json({ message: 'Server starting' });
  }
  if (action === 'stop') {
    const p = processes.get(id);
    if (!p || p.child.exitCode !== null) return res.status(409).json({ error: 'Server is not running' });
    p.child.stdin.write('stop\n');
    const timer = setTimeout(() => { if (p.child.exitCode === null) p.child.kill('SIGTERM'); }, 15000); timer.unref();
    return res.status(202).json({ message: 'Stop requested' });
  }
  return res.status(404).json({ error: 'Unknown action' });
});
function startServer(id) {
  const server = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  if (!server) return;
  const dir = serverDir(server), jarPath = path.resolve(dir, server.jar);
  if (!jarPath.startsWith(dir + path.sep) || !fs.existsSync(jarPath)) throw new Error(`Place ${server.jar} in this server's directory first.`);
  const child = spawn(process.env.JAVA_BIN || 'java', [`-Xms${server.min_memory}M`, `-Xmx${server.max_memory}M`, '-jar', jarPath, 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LANG: 'C.UTF-8' } });
  const entry = { child, startedAt: new Date().toISOString(), players: '—' }; processes.set(id, entry);
  const consume = (stream, prefix = '') => { let data = ''; stream.on('data', chunk => { data += chunk.toString(); const rows = data.split(/\r?\n/); data = rows.pop() || ''; for (const row of rows) { if (!row.trim()) continue; logLine(id, prefix + row); const m = row.match(/There are (\d+) of a max of (\d+) players online/); if (m) entry.players = `${m[1]} / ${m[2]}`; } }); stream.on('end', () => { if (data.trim()) logLine(id, prefix + data); }); };
  consume(child.stdout); consume(child.stderr, '[err] ');
  child.on('error', err => logLine(id, `Panel: failed to launch Java: ${err.message}`));
  child.on('close', code => { entry.players = '—'; logLine(id, `Panel: process exited (code ${code})`); });
  logLine(id, `Panel: starting ${server.jar}`);
}
app.get('/api/servers/:id/console', requireAuth, (req, res) => {
  const id = Number(req.params.id), before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  if (!db.prepare('SELECT id FROM servers WHERE id=?').get(id)) return res.status(404).json({ error: 'Server not found' });
  const lines = db.prepare('SELECT id,line,created_at FROM console_lines WHERE server_id=? AND id<? ORDER BY id DESC LIMIT 200').all(id, before).reverse();
  res.json({ lines, nextBefore: lines.length ? lines[0].id : before });
});
function getServer(id, res) { const s = db.prepare('SELECT * FROM servers WHERE id=?').get(Number(id)); if (!s) res.status(404).json({ error: 'Server not found' }); return s; }
function safeFile(server, relative = '') {
  if (typeof relative !== 'string' || relative.length > 500 || relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid path');
  const parts = relative.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Hidden and parent paths are not accessible');
  let current = serverDir(server);
  for (const part of parts) { current = path.join(current, part); if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not accessible'); }
  if (current !== serverDir(server) && !current.startsWith(serverDir(server) + path.sep)) throw new Error('Invalid path');
  return current;
}
app.get('/api/servers/:id/files', requireAuth, (req, res) => {
  const s = getServer(req.params.id, res); if (!s) return;
  try { const dir = safeFile(s, req.query.path || ''); const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.')).map(e => { const p = path.join(dir, e.name); const st = fs.lstatSync(p); if (st.isSymbolicLink()) return null; return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: st.size, modifiedAt: st.mtime.toISOString() }; }).filter(Boolean).sort((a,b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1); res.json({ path: req.query.path || '', entries }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/servers/:id/file', requireAuth, (req, res) => { const s = getServer(req.params.id, res); if (!s) return; try { const p = safeFile(s, req.query.path); if (!fs.statSync(p).isFile()) return res.status(400).json({ error: 'Not a file' }); if (fs.statSync(p).size > 1024 * 1024) return res.status(413).json({ error: 'Files over 1 MB cannot be edited in the panel' }); res.json({ content: fs.readFileSync(p, 'utf8') }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.put('/api/servers/:id/file', requireAuth, (req, res) => { const s = getServer(req.params.id, res); if (!s) return; const { path: rel, content } = req.body || {}; if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) return res.status(400).json({ error: 'Text files are limited to 1 MB' }); try { const p = safeFile(s, rel); if (fs.existsSync(p) && !fs.statSync(p).isFile()) return res.status(400).json({ error: 'Not a file' }); fs.writeFileSync(p, content, { mode: 0o600 }); res.json({ ok: true }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/servers/:id/file', requireAuth, (req, res) => { const s = getServer(req.params.id, res); if (!s) return; try { const p = safeFile(s, req.body?.path); if (p === serverDir(s)) return res.status(400).json({ error: 'Cannot remove server root' }); fs.rmSync(p, { recursive: true, force: false }); res.json({ ok: true }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.post('/api/servers/:id/upload', requireAuth, async (req, res) => {
  const s = getServer(req.params.id, res);
  if (!s) return;
  const MAX_UPLOAD = 64 * 1024 * 1024;
  let temporary = null;
  try {
    const name = decodeURIComponent(req.get('x-file-name') || '');
    const uploadPath = decodeURIComponent(req.get('x-file-path') || '');
    if (!name || name.length > 255 || name === '.' || name === '..' || name.startsWith('.') || /[\\\\/\\x00-\\x1f\\x7f]/.test(name)) {
      return res.status(400).json({ error: 'Invalid filename. Hidden files and path separators are not allowed.' });
    }
    const declaredLength = Number(req.get('content-length') || 0);
    if (declaredLength > MAX_UPLOAD) return res.status(413).json({ error: 'Upload exceeds the 64 MB limit.' });
    const target = safeFile(s, [uploadPath, name].filter(Boolean).join('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    temporary = path.join(path.dirname(target), `.upload-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let size = 0;
    const limiter = new (require('stream').Transform)({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD) return callback(new Error('Upload exceeds the 64 MB limit.'));
        callback(null, chunk);
      }
    });
    await require('stream/promises').pipeline(req, limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    fs.renameSync(temporary, target);
    temporary = null;
    return res.status(201).json({ ok: true, size, filename: name });
  } catch (error) {
    if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch {} }
    if (res.headersSent || res.destroyed) return;
    const status = /64 MB limit/.test(error.message) ? 413 : 400;
    return res.status(status).json({ error: error.message || 'Upload failed.' });
  }
});
async function downloadRemoteFile(rawUrl, destination, maxBytes, redirects = 0) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw new Error('Only public HTTPS download links on port 443 are allowed.');
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Private or local hosts are not allowed.');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(x => {
    const a = x.address.toLowerCase();
    if (x.family === 4) { const p = a.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224; }
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.');
  })) throw new Error('The download link resolves to a private or restricted address.');
  return await new Promise((resolve, reject) => {
    const lookup = (_host, options, callback) => {
      if (options && options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    };
    const request = https.get(parsed, { lookup, timeout: 20000, headers: { 'User-Agent': 'BlockPanel/1.0' } }, response => {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        const location = response.headers.location; response.resume();
        if (!location) return reject(new Error('Download redirect did not include a location.'));
        const next = new URL(location, parsed).toString();
        if (redirects >= 3) return reject(new Error('Too many download redirects.'));
        return downloadRemoteFile(next, destination, maxBytes, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error('Remote server returned HTTP ' + response.statusCode + '.')); }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) { response.destroy(); return reject(new Error('Remote file exceeds the 64 MB limit.')); }
      let size = 0;
      const limiter = new (require('stream').Transform)({ transform(chunk, enc, cb) { size += chunk.length; if (size > maxBytes) return cb(new Error('Remote file exceeds the 64 MB limit.')); cb(null, chunk); } });
      require('stream/promises').pipeline(response, limiter, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })).then(() => resolve(size), reject);
    });
    request.setTimeout(20000, () => request.destroy(new Error('Remote download timed out.')));
    request.on('error', reject);
  });
}
app.post('/api/servers/:id/download-url', requireAuth, async (req, res) => {
  const server = getServer(req.params.id, res);
  if (!server) return;
  const MAX_DOWNLOAD = 64 * 1024 * 1024;
  let temporary = null;
  try {
    const rawUrl = req.body?.url;
    const folder = typeof req.body?.path === 'string' ? req.body.path : '';
    if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return res.status(400).json({ error: 'Enter a valid HTTPS download URL.' });
    const parsed = new URL(rawUrl);
    let filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : path.basename(decodeURIComponent(parsed.pathname));
    if (!filename || filename.length > 255 || filename.startsWith('.') || /[\\\\/\\x00-\\x1f\\x7f]/.test(filename) || filename === '.' || filename === '..') return res.status(400).json({ error: 'Enter a valid filename.' });
    const target = safeFile(server, [folder, filename].filter(Boolean).join('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    temporary = path.join(path.dirname(target), '.download-' + crypto.randomBytes(12).toString('hex') + '.tmp');
    const size = await downloadRemoteFile(rawUrl, temporary, MAX_DOWNLOAD);
    fs.renameSync(temporary, target);
    temporary = null;
    return res.status(201).json({ ok: true, filename, size });
  } catch (error) {
    if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch {} }
    return res.status(400).json({ error: error.message || 'Remote download failed.' });
  }
});
app.get('/api/servers/:id/download', requireAuth, (req, res) => { const s = getServer(req.params.id, res); if (!s) return; try { const p = safeFile(s, req.query.path); if (!fs.statSync(p).isFile()) return res.status(400).json({ error: 'Not a file' }); res.download(p, path.basename(p)); } catch(e) { res.status(400).json({ error: e.message }); } });
function directorySize(dir) { let size = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir,e.name); if (e.isSymbolicLink()) continue; size += e.isDirectory() ? directorySize(p) : fs.statSync(p).size; } return size; }
app.get('/api/servers/:id/backups', requireAuth, (req,res) => { const s = getServer(req.params.id,res); if (s) res.json(db.prepare('SELECT id,label,size,created_at AS createdAt FROM backups WHERE server_id=? ORDER BY id DESC').all(s.id)); });
app.post('/api/servers/:id/backups', requireAuth, (req,res) => { const s = getServer(req.params.id,res); if (!s) return; if (processes.get(s.id)?.child.exitCode === null) return res.status(409).json({error:'Stop the server before creating a consistent backup'}); const dir = `server-${s.id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`; const dest = path.join(BACKUPS_DIR,dir); try { fs.cpSync(serverDir(s),dest,{recursive:true,dereference:false,filter:src=>!fs.lstatSync(src).isSymbolicLink()}); const size = directorySize(dest); const label = new Date().toISOString(); const info=db.prepare('INSERT INTO backups (server_id,label,directory,size) VALUES (?,?,?,?)').run(s.id,label,dir,size); res.status(201).json({id:info.lastInsertRowid,label,size}); } catch(e) { fs.rmSync(dest,{recursive:true,force:true}); res.status(500).json({error:`Backup failed: ${e.message}`}); } });
app.post('/api/servers/:id/backups/:backupId/restore', requireAuth, (req,res) => { const s=getServer(req.params.id,res); if (!s) return; if (processes.get(s.id)?.child.exitCode === null) return res.status(409).json({error:'Stop the server before restoring a backup'}); const b=db.prepare('SELECT * FROM backups WHERE id=? AND server_id=?').get(Number(req.params.backupId),s.id); if (!b) return res.status(404).json({error:'Backup not found'}); try { const target=serverDir(s); for (const e of fs.readdirSync(target)) { const p=path.join(target,e); fs.rmSync(p,{recursive:true,force:true}); } fs.cpSync(path.join(BACKUPS_DIR,b.directory),target,{recursive:true,dereference:false}); res.json({ok:true}); } catch(e) { res.status(500).json({error:`Restore failed: ${e.message}`}); } });
app.delete('/api/servers/:id/backups/:backupId', requireAuth, (req,res) => { const s=getServer(req.params.id,res); if (!s) return; const b=db.prepare('SELECT * FROM backups WHERE id=? AND server_id=?').get(Number(req.params.backupId),s.id); if (!b) return res.status(404).json({error:'Backup not found'}); fs.rmSync(path.join(BACKUPS_DIR,b.directory),{recursive:true,force:true}); db.prepare('DELETE FROM backups WHERE id=?').run(b.id); res.json({ok:true}); });
app.post('/api/servers/:id/command', requireAuth, (req, res) => {
  const id = Number(req.params.id), p = processes.get(id), command = req.body?.command;
  if (!p || p.child.exitCode !== null) return res.status(409).json({ error: 'Server is offline' });
  if (typeof command !== 'string' || !command.trim() || command.length > 200 || /[\r\n\x00]/.test(command)) return res.status(400).json({ error: 'Enter a single command up to 200 characters.' });
  p.child.stdin.write(command.trim() + '\n'); logLine(id, `> ${command.trim()}`); res.json({ ok: true });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found. The backend may be outdated; pull the latest main branch and restart the panel.' }));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`BlockPanel listening on http://localhost:${port}`));
