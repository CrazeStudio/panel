const test = require('node:test');
const assert = require('node:assert/strict');
const eggs = require('../eggs/index.json');

test('egg catalogue contains supported Minecraft server types', () => {
  for (const id of ['paper', 'purpur', 'vanilla', 'fabric', 'forge', 'neoforge', 'bedrock']) {
    assert.ok(eggs[id], `missing ${id} egg`);
    assert.ok(eggs[id].name);
    assert.ok(eggs[id].image);
    assert.match(eggs[id].containerPort, /^\d+\/(tcp|udp)$/);
    assert.ok(Number.isInteger(eggs[id].defaultPort));
  }
});

test('egg images are restricted to the known itzg images', () => {
  for (const egg of Object.values(eggs)) {
    assert.match(egg.image, /^itzg\/minecraft(-bedrock-server|-server):/);
  }
});


const { hasPortConflict } = require('../panel/src/routes/servers');

test('prevents duplicate TCP allocations on the same node and port', () => {
  assert.equal(hasPortConflict([{ id: 'one', egg_id: 'paper' }], 'purpur'), true);
  assert.equal(hasPortConflict([{ id: 'one', egg_id: 'vanilla' }], 'fabric'), true);
});

test('allows the same numeric port when transports differ', () => {
  assert.equal(hasPortConflict([{ id: 'one', egg_id: 'paper' }], 'bedrock'), false);
  assert.equal(hasPortConflict([{ id: 'one', egg_id: 'bedrock' }], 'paper'), false);
});

test('prevents duplicate UDP allocations', () => {
  assert.equal(hasPortConflict([{ id: 'one', egg_id: 'bedrock' }], 'bedrock'), true);
});
