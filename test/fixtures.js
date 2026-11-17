// Builds throwaway "packaged apps" from the real Electron binary in
// node_modules/electron, with whatever app code a test needs.

import { cp, mkdtemp, rm, writeFile, mkdir, readFile, open } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function electronDist() {
  try {
    const exe = require('electron'); // path to the binary
    const dist = join(dirname(require.resolve('electron')), 'dist');
    return existsSync(exe) ? dist : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string | Buffer>} files  app files (package.json is added if missing)
 * @param {{ asar?: boolean, sign?: boolean, resources?: Record<string, {data: Buffer, mode?: number}> }} opts
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
 */
export async function makeApp(files, { asar = false, sign = true, resources = {} } = {}) {
  const dist = electronDist();
  const dir = await mkdtemp(join(tmpdir(), 'electron-smoke-test-'));
  let root, resourcesDir;
  if (process.platform === 'darwin') {
    root = join(dir, 'Fixture.app');
    await cp(join(dist, 'Electron.app'), root, { recursive: true, verbatimSymlinks: true });
    resourcesDir = join(root, 'Contents', 'Resources');
  } else {
    root = join(dir, `${process.platform === 'win32' ? 'win' : 'linux'}-unpacked`);
    await cp(dist, root, { recursive: true, verbatimSymlinks: true });
    resourcesDir = join(root, 'resources');
  }
  await rm(join(resourcesDir, 'default_app.asar'), { force: true });

  const all = { 'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'main.js' }), ...files };
  if (asar) writeAsar(join(resourcesDir, 'app.asar'), all);
  else
    for (const [name, data] of Object.entries(all)) {
      const p = join(resourcesDir, 'app', name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    }
  for (const [name, { data, mode = 0o755 }] of Object.entries(resources)) {
    const p = join(resourcesDir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode });
  }

  if (process.platform === 'darwin' && sign) execFileSync('codesign', ['--force', '--deep', '--sign', '-', root], { stdio: 'ignore' });
  return { path: root, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }) };
}

/** Write an asar archive (the format src/asar.js reads). */
export function writeAsar(dest, files) {
  const header = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const parts = name.split('/');
    let node = header;
    for (const dir of parts.slice(0, -1)) node = node.files[dir] ??= { files: {} };
    node.files[parts.at(-1)] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeUInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const pre = Buffer.alloc(8);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(pickle.length, 4);
  writeFileSync(dest, Buffer.concat([pre, pickle, ...chunks]));
}

/** First 4 KiB of the real Electron executable: a valid header for this OS/arch. */
export async function hostBinaryHeader() {
  const fh = await open(require('electron'), 'r');
  const buf = Buffer.alloc(4096);
  await fh.read(buf, 0, 4096, 0);
  await fh.close();
  return buf;
}

/** A Mach-O / ELF / PE header for the given arch, matching this OS's format. */
export function headerFor(arch) {
  const buf = Buffer.alloc(512);
  if (process.platform === 'darwin') {
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    buf.writeUInt32LE(8, 12); // MH_BUNDLE, like a .node file
  } else if (process.platform === 'linux') {
    buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    buf.writeUInt16LE(3, 16);
    buf.writeUInt16LE(arch === 'arm64' ? 0xb7 : 0x3e, 18);
  } else {
    buf.set([0x4d, 0x5a], 0);
    buf.writeUInt32LE(0x80, 0x3c);
    buf.writeUInt32LE(0x00004550, 0x80);
    buf.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
  }
  return buf;
}

export const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';

export const GOOD_MAIN = `
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  win.loadFile(path.join(__dirname, 'index.html'));
});
`;
export const INDEX_HTML = '<!doctype html><title>fixture</title><p>ok</p>';

export { readFile };
