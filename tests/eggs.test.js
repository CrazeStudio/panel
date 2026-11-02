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
