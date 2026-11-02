const crypto = require('node:crypto');

function getKey() {
  const raw = process.env.PANEL_APP_KEY || '';
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PANEL_APP_KEY must be 32 bytes as 64 hex characters or base64.');
  return key;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    cipher: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSecret(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(record.token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.token_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.token_cipher, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encryptSecret, decryptSecret, randomToken };
