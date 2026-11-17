#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { smoke, DEFAULTS } from '../src/index.js';

const HELP = `electron-smoke: check a packaged Electron app actually works before you ship it.

Usage
  npx electron-smoke [path]

  path   packager output folder (default: dist, then out), an .app bundle,
         a win-unpacked / linux-unpacked folder, a .dmg, or an .AppImage

Options
  --timeout <s>             seconds to wait for a window (default ${DEFAULTS.timeout})
  --stay <s>                seconds the app must stay up after its window opens (default ${DEFAULTS.stay})
  --expect <glob>           file that must be inside the app (asar), repeatable
  --expect-resource <glob>  file that must be in resources/ (extraResources), repeatable
  --arg <value>             extra argument passed to the app, repeatable
  --no-launch               static checks only (no app launch)
  --no-window               app has no window (tray/background): pass if it stays running
  --no-native-load          skip loading native modules inside the packaged runtime
  --sandbox                 keep Chromium's sandbox on Linux (default adds --no-sandbox)
  --notarized               macOS: require notarization + Gatekeeper approval
  --signed                  Windows: require a valid Authenticode signature
  --json                    print machine-readable results (codes + fixes)
  --report <file>           also write the JSON results to a file
  -v, --version
  -h, --help

Exit code 0 when every check passes, 1 otherwise.
Docs and error codes: https://github.com/Chris-garibay/electron-smoke`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      timeout: { type: 'string' },
      stay: { type: 'string' },
      expect: { type: 'string', multiple: true },
      'expect-resource': { type: 'string', multiple: true },
      arg: { type: 'string', multiple: true },
      'no-launch': { type: 'boolean' },
      'no-window': { type: 'boolean' },
      'no-native-load': { type: 'boolean' },
      sandbox: { type: 'boolean' },
      notarized: { type: 'boolean' },
      signed: { type: 'boolean' },
      json: { type: 'boolean' },
      report: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}

const { values: v, positionals } = parsed;
if (v.help) {
  console.log(HELP);
  process.exit(0);
}
if (v.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  process.exit(0);
}

const num = (s, name) => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number of seconds`);
    process.exit(2);
  }
  return n;
};

let target = positionals[0];
if (!target) {
  const { existsSync } = await import('node:fs');
  target = ['dist', 'out', 'release'].find((d) => existsSync(d)) ?? 'dist';
}

const result = await smoke(target, {
  timeout: num(v.timeout, 'timeout'),
  stay: num(v.stay, 'stay'),
  expect: v.expect ?? [],
  expectResource: v['expect-resource'] ?? [],
  args: v.arg ?? [],
  launch: !v['no-launch'],
  window: !v['no-window'],
  loadNative: !v['no-native-load'],
  sandbox: !!v.sandbox,
  notarized: !!v.notarized,
  signed: !!v.signed,
  json: !!v.json,
}).catch((e) => {
  console.error(`electron-smoke crashed: ${e.stack ?? e}`);
  process.exit(2);
});

if (v.report) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(v.report, JSON.stringify(result, null, 2));
}
process.exit(result.ok ? 0 : 1);
