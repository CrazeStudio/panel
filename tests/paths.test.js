const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInside, safeServerId } = require('../agent/src/paths');

test('resolves a normal path inside the server directory', () => {
  const root = path.join(os.tmpdir(), 'crazepanel-test-root');
  assert.equal(resolveInside(root, 'plugins'), path.join(root, 'plugins'));
});

test('rejects parent traversal, absolute paths and hidden paths', () => {
  const root = path.join(os.tmpdir(), 'crazepanel-test-root');
  assert.throws(() => resolveInside(root, '../outside'));
  assert.throws(() => resolveInside(root, '/etc/passwd'));
  assert.throws(() => resolveInside(root, '.env'));
  assert.throws(() => resolveInside(root, 'folder/../secret'));
});

test('rejects symbolic links', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crazepanel-path-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  const link = path.join(root, 'server-link');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link, 'dir');
  assert.throws(() => resolveInside(root, 'server-link/private.txt'), /Symbolic links/);
});

test('validates UUID-shaped server identifiers', () => {
  assert.equal(safeServerId('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(safeServerId('../etc/passwd'), false);
  assert.equal(safeServerId(''), false);
});
