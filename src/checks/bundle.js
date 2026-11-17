// Static checks on what got packaged: entry point, runtime dependencies,
// files the user expects, and files that should not ship.

import { relative, sep } from 'node:path';
import { walk, globToRegExp } from '../contents.js';
import { namesOtherOs } from './native.js';
import { builtinModules } from 'node:module';

const BUILTIN = new Set([...builtinModules, 'electron', 'original-fs']);

const CHECK = 'bundle';
const SECRET = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.p12|[^/]+\.key)$/i;

/**
 * @param {import('../find-app.js').App} app
 * @param {Awaited<ReturnType<import('../contents.js').loadContents>>} contents
 * @param {import('../report.js').Reporter} report
 */
export async function checkBundle(app, contents, opts, report) {
  const raw = contents.read('package.json');
  if (!raw) return report.fail(CHECK, 'E_PACKAGE_JSON_MISSING');
  let pkg;
  try {
    pkg = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return report.fail(CHECK, 'E_PACKAGE_JSON_MISSING', `package.json in the packaged app is not valid JSON: ${e.message}`);
  }

  // Entry point
  const main = (pkg.main ?? 'index.js').replace(/^\.\//, '').replace(/\/$/, '');
  const mainHit = [main, `${main}.js`, `${main}/index.js`].find((p) => contents.files.has(p));
  if (mainHit) {
    report.pass(CHECK, `main entry ${mainHit} is packaged`);
    app.unresolved = unresolvedRequires(contents, mainHit);
  }
  else report.fail(CHECK, 'E_MAIN_MISSING', `main entry "${pkg.main ?? 'index.js'}" is not in the packaged app`);

  // Runtime dependencies. Apps that bundle their code (webpack, vite, esbuild)
  // legitimately drop node_modules, so a missing dependency only counts when
  // the app's own code still loads it with require() or import.
  const deps = Object.keys(pkg.dependencies ?? {});
  const present = new Set();
  for (const f of contents.files) {
    const m = f.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
    if (m) present.add(m[1]);
  }
  const absent = deps.filter((d) => !present.has(d));
  if (absent.length) {
    const used = loadedPackages(contents, new Set(absent.filter((d) => !namesOtherOs(d, app.platform))));
    const missing = absent.filter((d) => used.has(d));
    // Static analysis cannot see platform checks or eval'd code, so this is a
    // warning. A real missing module fails the launch check with E_DEP_MISSING.
    if (missing.length) report.warn(CHECK, 'W_DEP_UNRESOLVED', `dependencies referenced in app code but not packaged: ${missing.join(', ')}`);
    else report.pass(CHECK, `${deps.length - absent.length} runtime dependencies packaged, ${absent.length} bundled into the app code`);
  } else if (deps.length) {
    report.pass(CHECK, `all ${deps.length} runtime dependencies are packaged`);
  }

  // Files the user said must exist
  for (const pattern of opts.expect) {
    const re = globToRegExp(pattern.replace(/^\.\//, ''));
    if ([...contents.files].some((f) => re.test(f))) report.pass(CHECK, `found ${pattern}`);
    else report.fail(CHECK, 'E_EXPECTED_FILE_MISSING', `expected file not in app: ${pattern}`);
  }
  if (opts.expectResource.length) {
    const resFiles = (await walk(app.resourcesDir)).map((f) => relative(app.resourcesDir, f).split(sep).join('/'));
    for (const pattern of opts.expectResource) {
      const re = globToRegExp(pattern.replace(/^\.\//, ''));
      if (resFiles.some((f) => re.test(f))) report.pass(CHECK, `found resource ${pattern}`);
      else report.fail(CHECK, 'E_EXPECTED_FILE_MISSING', `expected resource not in ${relative(app.root, app.resourcesDir) || 'resources'}/: ${pattern}`);
    }
  }

  // Things that should not ship
  const own = [...contents.files].filter((f) => !f.startsWith('node_modules/'));
  const secrets = own.filter((f) => SECRET.test(f) && looksSecret(f, contents.read(f)));
  if (secrets.length) report.warn(CHECK, 'W_SECRET_FILE_SHIPPED', `possible secrets packaged: ${secrets.slice(0, 10).join(', ')}`);

  const maps = own.filter((f) => f.endsWith('.map')).length;
  const ts = own.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')).length;
  const tsconfig = own.some((f) => /^tsconfig.*\.json$/.test(f));
  const bits = [maps && `${maps} source maps`, ts && `${ts} TypeScript sources`, tsconfig && 'tsconfig.json'].filter(Boolean);
  if (bits.length) report.warn(CHECK, 'W_SOURCE_SHIPPED', `dev files packaged: ${bits.join(', ')}`);

  return pkg;
}

const IMPORT = /(?:require\(\s*|import\(\s*|\bfrom\s*|\bimport\s+)["'`]((?:@[\w.-]+\/)?[\w.-]+)(?:\/[^"'`]*)?["'`]/g;
const SCAN_LIMIT = 300 * 1024 * 1024;

/** Which of `wanted` package names the app's own JS files load. */
function loadedPackages(contents, wanted) {
  const found = new Set();
  let budget = SCAN_LIMIT;
  for (const f of contents.files) {
    if (f.startsWith('node_modules/') || !/\.(c|m)?js$/.test(f)) continue;
    const buf = contents.read(f);
    if (!buf || (budget -= buf.length) < 0) break;
    for (const m of buf.toString('utf8').matchAll(IMPORT)) if (wanted.has(m[1])) found.add(m[1]);
    if (found.size === wanted.size) break;
  }
  return found;
}

/** Filter out config files and public certificates that only look sensitive by name. */
function looksSecret(file, buf) {
  if (!buf) return true;
  const text = buf.subarray(0, 64 * 1024).toString('utf8');
  if (/\.npmrc$/.test(file)) return /_auth(Token)?\s*=/.test(text);
  if (/\.(pem|key|p12)$/i.test(file)) return /\.p12$/i.test(file) || /PRIVATE KEY/.test(text);
  if (/(^|\/)\.env/.test(file)) return /^\s*[A-Z0-9_]+\s*=\s*\S/m.test(text);
  return true;
}

/**
 * Bare module names the main entry loads that are neither built in nor
 * packaged anywhere. Not reported on its own (optional requires in try/catch
 * are common); the launch check uses it to explain a startup failure.
 */
function unresolvedRequires(contents, main) {
  const buf = contents.read(main);
  if (!buf) return [];
  const present = new Set();
  for (const f of contents.files) {
    const m = f.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) present.add(m[1]);
  }
  const out = new Set();
  for (const m of buf.toString('utf8').matchAll(IMPORT)) {
    const name = m[1];
    const base = name.replace(/^node:/, '').split('/')[0];
    if (BUILTIN.has(name) || BUILTIN.has(base) || name.startsWith('node:') || name.startsWith('electron/') || present.has(name)) continue;
    out.add(name);
  }
  return [...out];
}
