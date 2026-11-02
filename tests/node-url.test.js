const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNodeUrl } = require('../panel/src/routes/nodes');

test('accepts an HTTP or HTTPS node origin', () => {
  assert.equal(validateNodeUrl('https://node.example.com:8080'), 'https://node.example.com:8080');
  assert.equal(validateNodeUrl('http://agent:8080'), 'http://agent:8080');
});

test('rejects credentials, query strings and non-HTTP protocols', () => {
  assert.equal(validateNodeUrl('ftp://node.example.com'), null);
  assert.equal(validateNodeUrl('https://user:pass@node.example.com'), null);
  assert.equal(validateNodeUrl('https://node.example.com?key=value'), null);
  assert.equal(validateNodeUrl('not-a-url'), null);
});
