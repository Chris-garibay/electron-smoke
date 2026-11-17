// A uniform view of the files inside a packaged app, whether it uses
// app.asar (+ app.asar.unpacked) or a plain resources/app folder.

import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Asar } from './asar.js';

export async function walk(dir, { skip = () => false } = {}) {
  const out = [];
  async function go(d) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(d, e.name);
      if (skip(p, e)) continue;
      if (e.isDirectory()) await go(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await go(dir);
  return out;
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * @param {import('./find-app.js').App} app
 */
export async function loadContents(app) {
  const asarPath = join(app.resourcesDir, 'app.asar');
  const unpackedDir = join(app.resourcesDir, 'app.asar.unpacked');

  if (existsSync(asarPath)) {
    const archive = new Asar(asarPath); // throws on corrupt archives
    const files = new Set(archive.files.keys());
    // Files under app.asar.unpacked are listed in the asar index with
    // `unpacked: true`, but also check disk in case they are not.
    if (existsSync(unpackedDir)) for (const f of await walk(unpackedDir)) files.add(toPosix(relative(unpackedDir, f)));
    return {
      kind: 'asar',
      files,
      unpackedDir,
      /** absolute path on disk, or null if the file only exists inside the archive */
      diskPath: (p) => (existsSync(join(unpackedDir, p)) ? join(unpackedDir, p) : null),
      isPacked: (p) => archive.has(p) && !archive.files.get(p).unpacked && !existsSync(join(unpackedDir, p)),
      read: (p) => archive.read(p) ?? (existsSync(join(unpackedDir, p)) ? readFileSync(join(unpackedDir, p)) : null),
    };
  }

  const appDir = join(app.resourcesDir, 'app');
  /** posix path inside the app → absolute path on disk */
  const disk = new Map();
  for (const f of await walk(appDir)) {
    let rel = toPosix(relative(appDir, f));
    // VS Code-style apps keep dependencies in app/node_modules.asar (+ .unpacked).
    if (rel.startsWith('node_modules.asar.unpacked/')) rel = `node_modules/${rel.slice('node_modules.asar.unpacked/'.length)}`;
    disk.set(rel, f);
  }
  const nested = disk.get('node_modules.asar');
  const nestedArchive = nested ? safeAsar(nested) : null;
  const files = new Set(disk.keys());
  if (nestedArchive) for (const p of nestedArchive.files.keys()) files.add(`node_modules/${p}`);
  const fromNested = (p) => (nestedArchive && p.startsWith('node_modules/') ? nestedArchive.read(p.slice('node_modules/'.length)) : null);
  return {
    kind: 'folder',
    files,
    unpackedDir: appDir,
    diskPath: (p) => disk.get(p) ?? null,
    isPacked: (p) => !disk.has(p) && files.has(p),
    read: (p) => (disk.has(p) ? readFileSync(disk.get(p)) : fromNested(p)),
  };
}

function safeAsar(p) {
  try {
    return new Asar(p);
  } catch {
    return null;
  }
}

/** Convert a simple glob (*, **, ?) to a RegExp over posix paths. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
