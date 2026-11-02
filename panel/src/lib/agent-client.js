const { decryptSecret } = require('./crypto');

class AgentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

async function agentRequest(db, nodeId, route, options = {}) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
  if (!node) throw new AgentError('The server node no longer exists.', 404);

  const base = new URL(node.url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new AgentError('The node URL must use HTTP or HTTPS.', 400);
  const target = new URL(route, base);
  if (target.origin !== base.origin) throw new AgentError('Invalid node API destination.', 400);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const token = decryptSecret(node);
    const response = await fetch(target, {
      method: options.method || 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch { throw new AgentError(`Node returned an invalid response (HTTP ${response.status}).`); }
    if (!response.ok) throw new AgentError(payload.error || `Node request failed (HTTP ${response.status}).`, response.status);
    db.prepare('UPDATE nodes SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(nodeId);
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new AgentError('Node did not respond before the timeout.', 504);
    if (error instanceof AgentError) throw error;
    throw new AgentError(`Unable to reach node: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { agentRequest, AgentError };
