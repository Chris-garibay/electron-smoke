// End-to-end: real Electron apps, broken on purpose, must fail with the right code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from '../src/index.js';
import { makeApp, electronDist, hostBinaryHeader, headerFor, otherArch, GOOD_MAIN, INDEX_HTML } from './fixtures.js';

const skip = !electronDist() && 'electron is not installed (npm install)';
const opts = { silent: true, timeout: 20, stay: 1 };

async function run(files, appOpts, smokeOpts) {
  const app = await makeApp(files, appOpts);
  try {
    return await smoke(app.path, { ...opts, ...smokeOpts });
  } finally {
    await app.cleanup();
  }
}
const codes = (r) => r.findings.filter((f) => f.code).map((f) => f.code);
const failures = (r) => r.findings.filter((f) => f.level === 'fail').map((f) => `${f.code}: ${f.message}`);

test('a working app passes (folder layout)', { skip }, async () => {
  const r = await run({ 'main.js': GOOD_MAIN, 'index.html': INDEX_HTML });
  assert.deepEqual(failures(r), []);
  assert.ok(r.findings.some((f) => f.check === 'launch' && /window opened/.test(f.message)));
});

test('a working app passes (asar layout)', { skip }, async () => {
  const r = await run({ 'main.js': GOOD_MAIN, 'index.html': INDEX_HTML }, { asar: true });
  assert.deepEqual(failures(r), []);
});

test('main process exception at startup is caught', { skip }, async () => {
  const r = await run({ 'main.js': "throw new Error('boom from fixture')" }, {}, { timeout: 6 });
  // macOS shows a dialog and prints nothing (BLOCKED); Linux and Windows print the stack (ERROR).
  const c = codes(r);
  assert.ok(c.includes('E_MAIN_PROCESS_BLOCKED') || c.includes('E_MAIN_PROCESS_ERROR'), failures(r).join('\n'));
  if (c.includes('E_MAIN_PROCESS_ERROR')) assert.ok(r.findings.some((f) => f.details?.includes('boom from fixture')));
});

test('missing module → E_DEP_MISSING', { skip }, async () => {
  const r = await run({ 'main.js': "require('fs'); require('node:path'); require('definitely-not-packaged')" }, {}, { timeout: 6 });
  assert.ok(failures(r).some((f) => f.includes('definitely-not-packaged') && !f.includes('node:path')), failures(r).join('\n'));
  assert.ok(codes(r).includes('E_DEP_MISSING'), failures(r).join('\n'));
});

test('app that quits → E_LAUNCH_EXITED', { skip }, async () => {
  const r = await run({ 'main.js': "require('electron').app.whenReady().then(() => process.exit(3))" });
  assert.ok(codes(r).includes('E_LAUNCH_EXITED'), failures(r).join('\n'));
});

test('no window → E_NO_WINDOW, and --no-window accepts it', { skip }, async () => {
  const files = { 'main.js': "require('electron').app.on('window-all-closed', () => {})" };
  const r = await run(files, {}, { timeout: 4 });
  assert.ok(codes(r).includes('E_NO_WINDOW'), failures(r).join('\n'));
  const ok = await run(files, {}, { window: false, stay: 2 });
  assert.deepEqual(failures(ok), []);
});

test('page that fails to load → E_RENDERER_LOAD_FAILED', { skip }, async () => {
  const main = GOOD_MAIN.replace("'index.html'", "'does-not-exist.html'");
  const r = await run({ 'main.js': main });
  assert.ok(codes(r).includes('E_RENDERER_LOAD_FAILED'), failures(r).join('\n'));
});

test('missing main entry → E_MAIN_MISSING', { skip }, async () => {
  const r = await run({ 'index.html': INDEX_HTML }, {}, { launch: false });
  assert.ok(codes(r).includes('E_MAIN_MISSING'));
});

test('wrong-arch native module → E_NATIVE_ARCH', { skip }, async () => {
  const r = await run({ 'main.js': GOOD_MAIN, 'node_modules/addon/build/Release/addon.node': headerFor(otherArch) }, {}, { launch: false });
  assert.ok(codes(r).includes('E_NATIVE_ARCH'), failures(r).join('\n'));
});

test('native module that cannot load → E_NATIVE_LOAD', { skip }, async () => {
  // Right format and arch, but not a real library.
  const r = await run({ 'main.js': GOOD_MAIN, 'node_modules/addon/build/Release/addon.node': headerFor(process.arch) }, {}, { launch: false });
  assert.ok(codes(r).includes('E_NATIVE_LOAD'), failures(r).join('\n'));
});

test('helper binary without +x → E_BINARY_NOT_EXECUTABLE', { skip: skip || (process.platform === 'win32' && 'no exec bit on Windows') }, async () => {
  const resources = { 'bin/helper': { data: await hostBinaryHeader(), mode: 0o644 } };
  const r = await run({ 'main.js': GOOD_MAIN }, { resources }, { launch: false });
  assert.ok(codes(r).includes('E_BINARY_NOT_EXECUTABLE'), failures(r).join('\n'));
});

test('--expect and --expect-resource', { skip }, async () => {
  const resources = { 'bin/tool.txt': { data: Buffer.from('x') } };
  const r = await run({ 'main.js': GOOD_MAIN, 'out/preload.js': '' }, { resources }, {
    launch: false,
    expect: ['out/*.js', 'out/renderer/index.html'],
    expectResource: ['bin/tool.txt', 'bin/missing'],
  });
  const missing = r.findings.filter((f) => f.code === 'E_EXPECTED_FILE_MISSING').map((f) => f.message);
  assert.equal(missing.length, 2, missing.join('\n'));
  assert.ok(missing.some((m) => m.includes('out/renderer/index.html')));
  assert.ok(missing.some((m) => m.includes('bin/missing')));
});

test('.env with values → W_SECRET_FILE_SHIPPED', { skip }, async () => {
  const r = await run({ 'main.js': GOOD_MAIN, '.env': 'API_KEY=sk-123\n', 'config/.env.example': 'API_KEY=\n' }, {}, { launch: false });
  const w = r.findings.filter((f) => f.code === 'W_SECRET_FILE_SHIPPED');
  assert.equal(w.length, 1);
  assert.ok(!w[0].message.includes('example'));
});

test('unsigned macOS bundle → E_MAC_SIGNATURE_INVALID', { skip: skip || (process.platform !== 'darwin' && 'macOS only') }, async () => {
  const r = await run({ 'main.js': GOOD_MAIN }, { sign: false }, { launch: false });
  assert.ok(codes(r).includes('E_MAC_SIGNATURE_INVALID'), failures(r).join('\n'));
});

test('empty folder → E_NO_APP_FOUND', async () => {
  const r = await smoke('test', { silent: true });
  assert.deepEqual(codes(r), ['E_NO_APP_FOUND']);
});
