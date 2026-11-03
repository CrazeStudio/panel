const fs = require('node:fs');
const path = require('node:path');
const fsp = fs.promises;
const { constants } = fs;

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const UPDATE_FLAGS = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function pathSegments(relative, allowEmpty = false) {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\')) {
    throw httpError('Invalid file path.');
  }
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw httpError('Absolute paths are not allowed.');
  }

  const parts = relative.split('/').filter(Boolean);
  if ((!allowEmpty && parts.length === 0) || parts.some((part) => part === '.' || part === '..' || part.startsWith('.'))) {
    throw httpError('Parent and hidden paths are not accessible.');
  }
  if (parts.some((part) => part.length > 255)) throw httpError('File name is too long.');
  return parts;
}

function fdPath(directory, name = '') {
  return `/proc/self/fd/${directory.fd}${name ? `/${name}` : ''}`;
}

async function openDirectory(root, relative = '') {
  const parts = pathSegments(relative, true);
  let current = await fsp.open(path.resolve(root), DIRECTORY_FLAGS);
  try {
    if (!(await current.stat()).isDirectory()) throw httpError('The requested path is not a directory.');
    for (const part of parts) {
      const next = await fsp.open(fdPath(current, part), DIRECTORY_FLAGS);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
}

async function openParent(root, relative) {
  const parts = pathSegments(relative);
  const name = parts.pop();
  const directory = await openDirectory(root, parts.join('/'));
  return { directory, name };
}

async function readBounded(handle, maximumBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maximumBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > maximumBytes) throw httpError(`File exceeds the ${maximumBytes} byte limit.`, 413);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function listFiles(root, relative = '') {
  const directory = await openDirectory(root, relative);
  try {
    const entries = await fsp.readdir(fdPath(directory), { withFileTypes: true });
    const files = [];
    for (const item of entries) {
      if (item.name.startsWith('.') || item.name.includes('\\')) continue;
      try {
        const stat = await fsp.lstat(fdPath(directory, item.name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
        files.push({
          name: item.name,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { path: relative || '', files };
  } finally {
    await directory.close();
  }
}

async function readFile(root, relative, maximumBytes, encoding = null) {
  const { directory, name } = await openParent(root, relative);
  let file;
  try {
    file = await fsp.open(fdPath(directory, name), READ_FLAGS);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw httpError('Only regular, unlinked files can be opened.');
    if (stat.size > maximumBytes) throw httpError(`File exceeds the ${maximumBytes} byte limit.`, 413);
    const content = await readBounded(file, maximumBytes);
    return encoding ? content.toString(encoding) : content;
  } finally {
    if (file) await file.close().catch(() => {});
    await directory.close();
  }
}

async function writeFile(root, relative, content, { exclusive = false, maximumBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw httpError('File content is invalid.');
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (data.byteLength > maximumBytes) throw httpError(`File content exceeds the ${maximumBytes} byte limit.`, 413);

  const { directory, name } = await openParent(root, relative);
  let file;
  try {
    try {
      file = await fsp.open(fdPath(directory, name), exclusive ? CREATE_FLAGS : UPDATE_FLAGS, 0o600);
    } catch (error) {
      if (exclusive && error.code === 'EEXIST') throw httpError('A file with that name already exists.', 409);
      throw error;
    }
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw httpError('Only regular, unlinked files can be changed.');
    if (!exclusive && stat.size > maximumBytes) throw httpError(`Existing file exceeds the ${maximumBytes} byte limit.`, 413);
    if (!exclusive) await file.truncate(0);
    await file.writeFile(data);
    return { ok: true, size: data.byteLength };
  } finally {
    if (file) await file.close().catch(() => {});
    await directory.close();
  }
}

async function createDirectory(root, relative) {
  const { directory, name } = await openParent(root, relative);
  try {
    try {
      await fsp.mkdir(fdPath(directory, name), { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') throw httpError('A file or folder with that name already exists.', 409);
      throw error;
    }
    return { ok: true };
  } finally {
    await directory.close();
  }
}

async function renameFile(root, sourcePath, newName) {
  if (typeof newName !== 'string' || !/^[a-zA-Z0-9_ .()-]{1,120}$/.test(newName) || newName.startsWith('.')) {
    throw httpError('Provide a valid source path and new file name.');
  }
  const { directory, name: sourceName } = await openParent(root, sourcePath);
  try {
    const source = fdPath(directory, sourceName);
    const destination = fdPath(directory, newName);
    const stat = await fsp.lstat(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw httpError('Only regular files and folders can be renamed.');
    }
    if (sourceName === newName) return { ok: true, path: sourcePath };

    try {
      await fsp.lstat(destination);
      throw httpError('A file or folder with that name already exists.', 409);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fsp.rename(source, destination);
    const parent = path.posix.dirname(sourcePath);
    return { ok: true, path: parent === '.' ? newName : `${parent}/${newName}` };
  } finally {
    await directory.close();
  }
}

async function deleteFile(root, relative) {
  const { directory, name } = await openParent(root, relative);
  try {
    const target = fdPath(directory, name);
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) throw httpError('Symbolic links cannot be deleted from the panel.');
    if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: false });
    else if (stat.isFile()) await fsp.unlink(target);
    else throw httpError('Only regular files and folders can be deleted.');
    return { ok: true };
  } finally {
    await directory.close();
  }
}

module.exports = { listFiles, readFile, writeFile, createDirectory, renameFile, deleteFile };
