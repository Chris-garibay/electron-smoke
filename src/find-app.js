// Locate packaged Electron apps in a path: an .app bundle, an unpacked
// output folder (win-unpacked, linux-unpacked, Forge's out/<name>-<os>-<arch>),
// a .dmg or an .AppImage.

import { readdir, stat, readFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectBinary } from './binary.js';

const run = promisify(execFile);
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'src']);
const NOT_MAIN_EXE = /^(uninstall|elevate|squirrel|update|chrome-sandbox|chrome_crashpad_handler|crashpad_handler)/i;

/**
 * @typedef {object} App
 * @property {string} label          short name for output
 * @property {'darwin'|'win32'|'linux'} platform
 * @property {string} root           .app bundle or unpacked folder
 * @property {string} executable     main binary
 * @property {string} resourcesDir   folder holding app.asar / app
 * @property {string} fuseBinary     binary that holds Electron's fuse wire
 * @property {string} [source]       installer it came from (.dmg, .AppImage)
 * @property {() => Promise<void>} [cleanup]
 */

/** @returns {Promise<App[]>} */
export async function findApps(input) {
  const target = resolve(input);
  const s = await stat(target).catch(() => null);
  if (!s) return [];

  if (s.isDirectory() && target.endsWith('.app')) return [await macApp(target)].filter(Boolean);
  if (s.isFile() && extname(target).toLowerCase() === '.dmg') return fromDmg(target);
  if (s.isFile() && target.endsWith('.AppImage')) return fromAppImage(target);
  if (s.isDirectory()) {
    const direct = await unpackedApp(target);
    if (direct) return [direct];

    const found = { apps: [], installers: [] };
    await scan(target, 0, found);
    if (found.apps.length) return found.apps;
    // No unpacked output. Fall back to testing installers directly.
    const out = [];
    for (const file of found.installers) {
      out.push(...(file.endsWith('.dmg') ? await fromDmg(file) : await fromAppImage(file)));
    }
    return out;
  }
  return [];
}

async function scan(dir, depth, found) {
  if (depth > 3) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.endsWith('.app')) {
        const app = await macApp(p);
        if (app) found.apps.push(app);
        continue;
      }
      const app = await unpackedApp(p);
      if (app) found.apps.push(app);
      else await scan(p, depth + 1, found);
    } else if (e.isFile() && (e.name.endsWith('.dmg') || e.name.endsWith('.AppImage'))) {
      found.installers.push(p);
    }
  }
}

function hasAppPayload(resourcesDir) {
  return existsSync(join(resourcesDir, 'app.asar')) || existsSync(join(resourcesDir, 'app', 'package.json'));
}

async function macApp(bundle) {
  const contents = join(bundle, 'Contents');
  const resourcesDir = join(contents, 'Resources');
  if (!hasAppPayload(resourcesDir)) return null;
  let exeName;
  try {
    const plist = await readFile(join(contents, 'Info.plist'), 'utf8');
    exeName = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  } catch {}
  if (!exeName) exeName = (await readdir(join(contents, 'MacOS')).catch(() => []))[0];
  if (!exeName) return null;
  return {
    label: basename(bundle),
    platform: 'darwin',
    root: bundle,
    executable: join(contents, 'MacOS', exeName),
    resourcesDir,
    fuseBinary: join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  };
}

async function unpackedApp(dir) {
  const resourcesDir = join(dir, 'resources');
  if (!hasAppPayload(resourcesDir)) return null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const e of entries) {
    if (!e.isFile() || NOT_MAIN_EXE.test(e.name)) continue;
    if (/\.(so(\.\d+)*|dll|pak|dat|bin|json|txt|html)$/i.test(e.name)) continue;
    const p = join(dir, e.name);
    const info = await inspectBinary(p);
    if (!info || !info.executable) continue;
    if (info.format === 'pe' && !e.name.toLowerCase().endsWith('.exe')) continue;
    const { size } = await stat(p);
    candidates.push({ p, info, size });
  }
  if (!candidates.length) return null;
  // The Electron main binary is by far the largest executable in the folder.
  candidates.sort((a, b) => b.size - a.size);
  const main = candidates[0];
  return {
    label: basename(dir),
    platform: main.info.format === 'pe' ? 'win32' : 'linux',
    root: dir,
    executable: main.p,
    resourcesDir,
    fuseBinary: main.p,
  };
}

async function fromDmg(dmg) {
  if (process.platform !== 'darwin') return [{ installerOnly: dmg }];
  const mnt = await mkdtemp(join(tmpdir(), 'electron-smoke-dmg-'));
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]);
  const cleanup = async () => {
    await run('hdiutil', ['detach', mnt, '-force']).catch(() => {});
    await rm(mnt, { recursive: true, force: true }).catch(() => {});
  };
  const apps = [];
  for (const name of await readdir(mnt)) {
    if (!name.endsWith('.app')) continue;
    const app = await macApp(join(mnt, name));
    if (app) apps.push({ ...app, label: `${basename(dmg)} → ${name}`, source: dmg });
  }
  if (!apps.length) {
    await cleanup();
    return [];
  }
  apps[0].cleanup = cleanup;
  return apps;
}

async function fromAppImage(file) {
  if (process.platform !== 'linux') return [{ installerOnly: file }];
  const dir = await mkdtemp(join(tmpdir(), 'electron-smoke-appimage-'));
  await chmod(file, 0o755);
  await run(file, ['--appimage-extract'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  const app = await unpackedApp(join(dir, 'squashfs-root'));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  if (!app) {
    await cleanup();
    return [];
  }
  return [{ ...app, label: basename(file), source: file, cleanup }];
}
