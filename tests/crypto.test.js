const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('../panel/src/lib/crypto');

test('encrypts and decrypts node tokens with AES-256-GCM', () => {
  process.env.PANEL_APP_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const token = 'f'.repeat(64);
  const encrypted = crypto.encryptSecret(token);

  assert.notEqual(encrypted.cipher, token);
  assert.equal(crypto.decryptSecret({
    token_cipher: encrypted.cipher,
    token_iv: encrypted.iv,
    token_tag: encrypted.tag,
  }), token);
});

test('rejects a malformed panel encryption key', () => {
  const original = process.env.PANEL_APP_KEY;
  process.env.PANEL_APP_KEY = 'short';
  assert.throws(() => crypto.getKey(), /32 bytes/);
  if (original === undefined) delete process.env.PANEL_APP_KEY;
  else process.env.PANEL_APP_KEY = original;
});
