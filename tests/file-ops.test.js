const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fileOps = require('../agent/src/file-ops');

test('server file operations cover create, edit, list, upload, download, rename and delete', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'crazepanel-file-ops-'));
  const root = path.join(base, 'server');
  await fs.mkdir(root);
  context.after(() => fs.rm(base, { recursive: true, force: true }));

  await fileOps.createDirectory(root, 'plugins');
  const listing = await fileOps.listFiles(root);
  assert.deepEqual(listing.files.map((item) => item.name), ['plugins']);

  await fileOps.writeFile(root, 'server.properties', 'motd=first', { exclusive: true });
  await assert.rejects(
    fileOps.writeFile(root, 'server.properties', 'motd=must-not-overwrite', { exclusive: true }),
    { status: 409 },
  );
  assert.equal(await fileOps.readFile(root, 'server.properties', 1024, 'utf8'), 'motd=first');

  await fileOps.writeFile(root, 'server.properties', 'motd=updated', { maximumBytes: 1024 });
  assert.equal(await fileOps.readFile(root, 'server.properties', 1024, 'utf8'), 'motd=updated');

  const binary = Buffer.from([0, 1, 2, 127, 128, 255]);
  await fileOps.writeFile(root, 'plugins/example.bin', binary, { exclusive: true, maximumBytes: 1024 });
  assert.deepEqual(await fileOps.readFile(root, 'plugins/example.bin', 1024), binary);
  assert.deepEqual((await fileOps.listFiles(root, 'plugins')).files.map((item) => item.name), ['example.bin']);

  await fileOps.renameFile(root, 'plugins/example.bin', 'renamed.bin');
  assert.deepEqual(await fileOps.readFile(root, 'plugins/renamed.bin', 1024), binary);
  await fileOps.writeFile(root, 'plugins/existing.bin', 'preserve', { exclusive: true, maximumBytes: 1024 });
  await assert.rejects(fileOps.renameFile(root, 'plugins/renamed.bin', 'existing.bin'), { status: 409 });
  assert.deepEqual(await fileOps.readFile(root, 'plugins/renamed.bin', 1024), binary);
  assert.deepEqual(await fileOps.renameFile(root, 'plugins/renamed.bin', 'renamed.bin'), { ok: true, path: 'plugins/renamed.bin' });
  await fileOps.deleteFile(root, 'plugins/renamed.bin');
  await fileOps.deleteFile(root, 'plugins');
  assert.deepEqual((await fileOps.listFiles(root)).files.map((item) => item.name), ['server.properties']);
});

test('server file operations reject traversal, symlinks, special files and hard-link writes', async (context) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'crazepanel-file-safe-'));
  const root = path.join(base, 'server');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  context.after(() => fs.rm(base, { recursive: true, force: true }));

  const missingOutside = path.join(outside, 'created-through-link.txt');
  await fs.symlink(missingOutside, path.join(root, 'dangling-link'));
  await assert.rejects(fileOps.writeFile(root, 'dangling-link', 'escape', { exclusive: true }));
  await assert.rejects(fileOps.readFile(root, 'dangling-link', 1024));
  await assert.rejects(fileOps.createDirectory(root, 'dangling-link/child'));
  await assert.equal(await fs.access(missingOutside).then(() => true, () => false), false);

  await fs.symlink(outside, path.join(root, 'outside-link'));
  await assert.rejects(fileOps.listFiles(root, 'outside-link'));
  await assert.rejects(fileOps.writeFile(root, 'outside-link/escaped.txt', 'escape', { exclusive: true }));

  const outsideFile = path.join(outside, 'shared.txt');
  await fs.writeFile(outsideFile, 'do not change');
  await fs.link(outsideFile, path.join(root, 'hard-link.txt'));
  await assert.rejects(fileOps.writeFile(root, 'hard-link.txt', 'changed', { maximumBytes: 1024 }));
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'do not change');

  await assert.rejects(fileOps.readFile(root, '../outside/shared.txt', 1024));
  await assert.rejects(fileOps.deleteFile(root, 'outside-link'));
});

test('server file reads enforce the configured size limit', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crazepanel-file-limit-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'large.txt'), '0123456789');
  await assert.rejects(fileOps.readFile(root, 'large.txt', 5), { status: 413 });
});
