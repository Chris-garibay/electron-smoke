// Launch the packaged app the way a user would and watch it start.
// Windows are detected through Chromium's remote debugging endpoint, so the
// app needs no test hooks or extra dependencies.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const CHECK = 'launch';
const MAIN_ERROR = /A JavaScript error occurred in the main process|Uncaught Exception:/;
const RENDERER_ERROR = /Unable to load preload script|render-process-gone|Renderer process (crashed|gone)/i;
const LOAD_FAILED = /Failed to load URL: (\S+) with error: (ERR_\w+)/;

export async function checkLaunch(app, opts, report) {
  const port = await freePort();
  let cmd = app.executable;
  let args = [`--remote-debugging-port=${port}`, ...opts.args];
  if (app.platform === 'linux' && !opts.sandbox) args.push('--no-sandbox');

  if (app.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    if (!hasCommand('xvfb-run')) {
      return report.fail(CHECK, 'E_LAUNCH_EXITED', 'no display available and xvfb-run is not installed (sudo apt-get install -y xvfb)');
    }
    args = ['-a', cmd, ...args];
    cmd = 'xvfb-run';
  }

  // ELECTRON_SMOKE=1 lets the app skip things like auto-update checks under test.
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1', ELECTRON_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const started = Date.now();
  const child = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: false,
  });

  let output = '';
  let exited = null;
  let fatal = null;
  const onData = (d) => {
    output += String(d).replace(/\x1b\[[0-9;]*m/g, '');
    if (output.length > 200_000) output = output.slice(-100_000);
    if (!fatal && MAIN_ERROR.test(output)) fatal = 'E_MAIN_PROCESS_ERROR';
    else if (!fatal && LOAD_FAILED.test(output)) fatal = 'E_RENDERER_LOAD_FAILED';
    else if (!fatal && RENDERER_ERROR.test(output)) fatal = 'E_RENDERER_CRASHED';
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => (exited = { code, signal }));
  child.on('error', (e) => (exited = { code: null, signal: null, error: e.message }));

  // x64 builds on Apple Silicon start slowly the first time Rosetta translates them.
  const rosetta = app.platform === 'darwin' && app.archs && !app.archs.includes(process.arch);
  const timeout = opts.timeout * (rosetta ? 2 : 1);
  const deadline = started + timeout * 1000;
  let cdpSeen = false;
  let windowAt = null;
  let pages = [];

  try {
    while (true) {
      await sleep(300);
      if (fatal) {
        const missing = output.match(/Cannot find module '([^']+)'/)?.[1];
        if (missing) return report.fail(CHECK, 'E_DEP_MISSING', `main process crashed: cannot find module '${missing}'`, output);
        const load = output.match(LOAD_FAILED);
        if (load) return report.fail(CHECK, fatal, `window failed to load ${shortUrl(load[1])} (${load[2]})`, output);
        return report.fail(CHECK, fatal, undefined, output);
      }
      if (exited) {
        const missing = output.match(/Cannot find module '([^']+)'/)?.[1];
        if (missing) return report.fail(CHECK, 'E_DEP_MISSING', `app exited: cannot find module '${missing}'`, output);
        if (app.unresolved?.length) return report.fail(CHECK, 'E_DEP_MISSING', `app exited; its main entry requires modules that are not packaged: ${app.unresolved.join(', ')}`, output);
        const how = exited.error ?? (exited.signal ? `signal ${exited.signal}` : `exit code ${exited.code}`);
        return report.fail(CHECK, 'E_LAUNCH_EXITED', `app exited after ${secs(started)} (${how})`, output);
      }
      const list = await listTargets(port);
      if (list) {
        cdpSeen = true;
        pages = list.filter((t) => t.type === 'page');
      }

      if (!windowAt && pages.length) {
        windowAt = Date.now();
        if (opts.window) report.pass(CHECK, `window opened after ${secs(started)}`);
      }
      if (!opts.window && cdpSeen && !windowAt) windowAt = Date.now(); // tray / background apps: a running browser process is success
      if (windowAt && Date.now() - windowAt >= opts.stay * 1000) break;
      if (Date.now() > deadline) {
        if (cdpSeen) return report.fail(CHECK, 'E_NO_WINDOW', `no window after ${timeout}s`, output);
        // Chromium starts its debugging endpoint within a second of a normal
        // start. A live process that never got there is blocked in the main
        // process, almost always on Electron's "JavaScript error" dialog.
        if (app.unresolved?.length) {
          return report.fail(CHECK, 'E_DEP_MISSING', `main process never finished starting; its main entry requires modules that are not packaged: ${app.unresolved.join(', ')}`, output);
        }
        return report.fail(CHECK, 'E_MAIN_PROCESS_BLOCKED', `main process never finished starting within ${timeout}s`, output);
      }
    }

    const broken = pages.filter((p) => p.url.startsWith('chrome-error://'));
    if (broken.length) return report.fail(CHECK, 'E_RENDERER_LOAD_FAILED', `${broken.length} window(s) show a load error page`, output);
    const shown = pages.map((p) => shortUrl(p.url)).slice(0, 3);
    report.pass(CHECK, opts.window ? `stayed up ${opts.stay}s with ${pages.length} page(s): ${shown.join(', ')}` : `main process started and stayed running for ${opts.stay}s`);
  } finally {
    await stop(child);
  }
}

async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    // Windows keeps the files locked until the processes are fully gone.
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    await sleep(500);
    return;
  }
  const kill = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
  kill('SIGKILL');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const shortUrl = (u) => u.replace(/^file:\/\/.*?\/(Resources|resources)\/(app\.asar|app)\//, 'app://');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;
