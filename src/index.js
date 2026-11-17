// Programmatic API: run every check against each app found at `target`.

import { findApps } from './find-app.js';
import { loadContents } from './contents.js';
import { Reporter } from './report.js';
import { checkBundle } from './checks/bundle.js';
import { checkNative } from './checks/native.js';
import { checkLaunch } from './checks/launch.js';
import { checkSigning } from './checks/signing.js';

export const DEFAULTS = {
  timeout: 30, // seconds to wait for a window
  stay: 3, // seconds the app must survive after the window opens
  expect: [],
  expectResource: [],
  args: [],
  launch: true,
  window: true,
  loadNative: true,
  sandbox: false,
  notarized: false,
  signed: false,
  json: false,
  silent: false, // print nothing; read `findings` from the result
};

/**
 * @param {string} target path to an app, installer or packager output folder
 * @param {Partial<typeof DEFAULTS>} options
 * @returns {Promise<{ok: boolean, passed: number, failed: number, warnings: number, findings: object[]}>}
 */
export async function smoke(target, options = {}) {
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  const report = new Reporter({ json: opts.json, silent: opts.silent });
  const found = await findApps(target);
  const apps = found.filter((a) => !a.installerOnly);

  report.section(target);
  for (const s of found.filter((a) => a.installerOnly)) report.warn('find', 'W_INSTALLER_SKIPPED', `skipped ${s.installerOnly}`);
  if (!apps.length) {
    report.fail('find', 'E_NO_APP_FOUND', `no packaged Electron app found in ${target}`);
    return report.finish();
  }

  for (const app of apps) {
    report.section(`${app.label}  ${app.platform}`);
    try {
      let contents;
      try {
        contents = await loadContents(app);
      } catch (e) {
        report.fail('bundle', 'E_ASAR_UNREADABLE', `could not read app.asar: ${e.message}`);
        continue;
      }
      await checkBundle(app, contents, opts, report);
      await checkNative(app, contents, opts, report);

      if (app.platform !== process.platform) {
        report.warn('launch', 'W_RUNTIME_SKIPPED', `built for ${app.platform}, running on ${process.platform}: launch checks skipped`);
        continue;
      }
      if (process.platform === 'darwin') await checkSigning(app, opts, report);
      if (opts.launch) await checkLaunch(app, opts, report);
      if (process.platform === 'win32') await checkSigning(app, opts, report);
    } finally {
      await app.cleanup?.();
    }
  }
  return report.finish();
}
