const fs = require('node:fs');
const path = require('node:path');

function resolveInside(root, relative = '') {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\')) {
    throw new Error('Invalid file path.');
  }
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error('Absolute paths are not allowed.');
  }

  const parts = relative.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('Parent and hidden paths are not accessible.');
  }

  const base = path.resolve(root);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not accessible.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (current !== base && !current.startsWith(base + path.sep)) {
    throw new Error('Path escapes the server directory.');
  }
  return current;
}

function safeServerId(value) {
  return /^[0-9a-f-]{36}$/i.test(String(value || ''));
}

module.exports = { resolveInside, safeServerId };
