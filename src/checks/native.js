// Native code checks: CPU architecture of every .node module and bundled
// executable, execute permissions, and an actual load test of each native
// module inside the packaged Electron runtime.

import { readFile, stat } from 'node:fs/promises';
import { join, relative, basename, extname, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { inspectBinary, parseHeader } from '../binary.js';
import { walk } from '../contents.js';

const CHECK = 'native';
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const PLATFORM_FORMAT = { darwin: 'macho', linux: 'elf', win32: 'pe' };

export async function checkNative(app, contents, opts, report) {
  const appBin = await inspectBinary(app.executable);
  if (!appBin) return report.fail(CHECK, 'E_LAUNCH_EXITED', `main executable is not a recognizable binary: ${app.executable}`);
  const appArchs = appBin.archs;
  app.archs = appArchs;
  report.pass(CHECK, `app binary is ${appArchs.join(' + ')}`);
  // Universal apps run every slice, so each module must contain all of them.
  const fits = (archs) => (appArchs.length > 1 ? appArchs.every((a) => archs.includes(a)) : archs.some((a) => appArchs.includes(a)));
  // The arch the app will actually run as on this machine (Rosetta runs x64 on arm64).
  const runArch = appArchs.includes(process.arch) ? process.arch : appArchs[0];

  // .node modules
  const nodeFiles = [...contents.files].filter((f) => f.endsWith('.node'));
  const packed = nodeFiles.filter((f) => contents.isPacked(f));
  if (packed.length) report.warn(CHECK, 'W_NATIVE_IN_ASAR', `${packed.length} native module(s) packed inside app.asar: ${packed.slice(0, 5).join(', ')}`);

  // A binary for another OS or arch is a bug, unless its path names that
  // platform (e.g. prebuilds/darwin-x64/, bin/linux/arm/): then the app picks
  // one at runtime and shipping the others is intentional.
  const format = PLATFORM_FORMAT[app.platform];
  const loadable = [];
  const otherPlatform = [];
  let badArch = 0;
  for (const f of nodeFiles) {
    const disk = contents.diskPath(f);
    const info = disk ? await inspectBinary(disk) : parseHeader(contents.read(f) ?? Buffer.alloc(0));
    if (!info) continue;
    if (info.format !== format || namesOtherOs(f, app.platform)) otherPlatform.push(f);
    else if (fits(info.archs)) loadable.push(f);
    else if (namesPlatform(f, info.archs)) otherPlatform.push(f);
    else {
      badArch++;
      report.fail(CHECK, 'E_NATIVE_ARCH', `${f} is ${info.archs.join(' + ')}, app is ${appArchs.join(' + ')}`);
    }
  }
  if (loadable.length && !badArch) report.pass(CHECK, `${loadable.length} native module(s) match the app architecture`);
  if (otherPlatform.length) report.info(CHECK, 'I_OTHER_PLATFORM_BINARIES', `${otherPlatform.length} native module(s) for other platforms, selected at runtime by path`);

  // Other executables shipped in resources (extraResources, unpacked helpers)
  const resourceFiles = await walk(app.resourcesDir, {
    skip: (p, e) => (e.isDirectory() && p.endsWith('.lproj')) || (e.isFile() && basename(p) === 'app.asar'),
  });
  let helpers = 0;
  let helpersOther = 0;
  for (const file of resourceFiles) {
    const ext = extname(file).toLowerCase();
    if (ext && !['.exe', '.dylib', '.so', '.dll', '.bin'].includes(ext) && !/\.so\.\d/.test(file)) continue;
    const info = await inspectBinary(file);
    if (!info || info.format !== format) continue;
    helpers++;
    const rel = relative(app.resourcesDir, file).split(sep).join('/');
    if (!fits(info.archs)) {
      if (namesPlatform(rel, info.archs)) helpersOther++;
      else report.warn(CHECK, 'W_BINARY_ARCH', `${rel} is ${info.archs.join(' + ')}, app is ${appArchs.join(' + ')}`);
    }
    const isExe = info.executable && !ext;
    if (isExe && process.platform !== 'win32') {
      const { mode } = await stat(file);
      if (!(mode & 0o111)) report.fail(CHECK, 'E_BINARY_NOT_EXECUTABLE', `${rel} is not executable (mode ${(mode & 0o777).toString(8)})`);
    }
  }
  if (helpers) report.pass(CHECK, `inspected ${helpers} bundled binar${helpers === 1 ? 'y' : 'ies'}`);
  if (helpersOther) report.info(CHECK, 'I_OTHER_PLATFORM_BINARIES', `${helpersOther} bundled binar${helpersOther === 1 ? 'y' : 'ies'} for other architectures, selected at runtime by path`);

  // Load test
  if (!loadable.length || !opts.loadNative) return;
  if (app.platform !== process.platform) return; // reported once by the caller
  if (!(await runAsNodeEnabled(app.fuseBinary))) return report.warn(CHECK, 'W_NATIVE_LOAD_SKIPPED');

  const toLoad = [];
  for (const f of loadable) {
    const disk = contents.diskPath(f);
    const info = disk ? await inspectBinary(disk) : parseHeader(contents.read(f) ?? Buffer.alloc(0));
    if (info?.archs.includes(runArch)) toLoad.push(f);
  }
  if (!toLoad.length) return;
  const paths = toLoad.map((f) => contents.diskPath(f) ?? join(app.resourcesDir, 'app.asar', f));
  const results = await loadInElectron(app.executable, paths, opts.timeout);
  if (!results) return report.warn(CHECK, 'W_NATIVE_LOAD_SKIPPED', 'native load test did not report results (RunAsNode may be blocked)');
  let failed = 0;
  results.forEach((r, i) => {
    if (r.ok) return;
    failed++;
    report.fail(CHECK, 'E_NATIVE_LOAD', `${toLoad[i]} failed to load`, r.error);
  });
  if (results.length < toLoad.length) report.skip(CHECK, `${toLoad.length - results.length} native module(s) not tried after the crash`);
  else if (!failed) report.pass(CHECK, `${results.length} native module(s) load in the packaged Electron runtime`);
}

async function runAsNodeEnabled(fuseBinary) {
  try {
    const buf = await readFile(fuseBinary);
    const at = buf.indexOf(FUSE_SENTINEL);
    if (at === -1) return true; // Electron older than fuses: RunAsNode is always on
    // Layout after the sentinel: version byte, length byte, then one byte per fuse.
    // RunAsNode is fuse 0. '1' = enabled, '0' = disabled, 'r' = removed.
    return buf[at + FUSE_SENTINEL.length + 2] === 0x31;
  } catch {
    return true;
  }
}

// Loads each module in the packaged runtime and streams one result line per
// module, so a module that crashes the process can still be named.
function loadInElectron(exe, paths, timeoutSec) {
  const script = `
    const paths = ${JSON.stringify(paths)};
    paths.forEach((p, i) => {
      let r;
      try { require(p); r = { i, ok: true }; }
      catch (e) { r = { i, ok: false, error: String(e && e.stack || e).split('\\n').slice(0, 6).join('\\n') }; }
      require('fs').writeSync(1, '\\n__ELECTRON_SMOKE__' + JSON.stringify(r) + '\\n');
    });
    process.exit(0);
  `;
  return new Promise((resolve) => {
    const child = spawn(exe, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.on('error', () => resolve(null));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const results = [];
      for (const m of out.matchAll(/__ELECTRON_SMOKE__(\{.*\})/g)) {
        try {
          const r = JSON.parse(m[1]);
          results[r.i] = r;
        } catch {}
      }
      if (!results.length && !timedOut && code === 0) return resolve(null); // script never ran: RunAsNode ignored
      const next = paths.findIndex((_, i) => !results[i]);
      if (next !== -1) {
        const why = timedOut ? `hung for ${timeoutSec}s` : `crashed the runtime (${signal ?? `exit code ${code}`})`;
        results[next] = { i: next, ok: false, error: `loading this module ${why}\n${err.trim().split('\n').slice(-6).join('\n')}`.trim() };
        // Modules after a crash were never tried.
        return resolve(results.slice(0, next + 1));
      }
      resolve(results);
    });
  });
}

const ARCH_WORDS = { x64: ['x64', 'x86_64', 'amd64'], arm64: ['arm64', 'aarch64'], ia32: ['ia32', 'x86', 'i386', 'i686'], arm: ['arm', 'armv7', 'armv7l', 'armhf'] };

/** True when a path segment names the binary's own arch (prebuilds/linux-x64/foo.node). */
function namesPlatform(path, archs) {
  const parts = path.toLowerCase().split(/[\/._-]+/);
  return archs.some((a) => (ARCH_WORDS[a] ?? [a]).some((w) => parts.includes(w)));
}

const OS_WORDS = { darwin: ['darwin', 'mac', 'macos', 'osx'], win32: ['win32', 'win', 'windows'], linux: ['linux'] };

/** True when a path segment names an OS other than the app's (build/Release/windows.node). */
export function namesOtherOs(path, platform) {
  const parts = path.toLowerCase().split(/[\\/._-]+/);
  return Object.entries(OS_WORDS).some(([os, words]) => os !== platform && words.some((w) => parts.includes(w)));
}
