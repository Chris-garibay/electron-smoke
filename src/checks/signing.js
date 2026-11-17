// Code signing checks. macOS signature validity always runs on macOS
// because a broken signature makes the app unopenable for users.
// Notarization (macOS) and Authenticode (Windows) run when requested.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CHECK = 'signing';

export async function checkSigning(app, opts, report) {
  if (app.platform === 'darwin') return mac(app, opts, report);
  if (app.platform === 'win32' && opts.signed) return windows(app, report);
}

async function mac(app, opts, report) {
  try {
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app.root]);
  } catch (e) {
    return report.fail(CHECK, 'E_MAC_SIGNATURE_INVALID', undefined, (e.stderr || e.message).toString());
  }
  const { stderr } = await run('codesign', ['-dv', '--verbose=2', app.root]).catch((e) => e);
  const details = String(stderr ?? '');
  const adhoc = /Signature=adhoc/.test(details);
  const authority = details.match(/Authority=([^\n]+)/)?.[1];
  report.pass(CHECK, `bundle signature is valid (${adhoc ? 'ad-hoc' : authority ?? 'signed'})`);

  if (adhoc && !opts.notarized) report.info(CHECK, 'I_MAC_ADHOC_SIGNED');
  if (!opts.notarized) return;

  const stapled = await run('xcrun', ['stapler', 'validate', app.root]).then(() => true, () => false);
  const gatekeeper = await run('spctl', ['--assess', '--type', 'execute', '-vv', app.root]).then(
    () => true,
    (e) => String(e.stderr ?? e.message),
  );
  if (stapled && gatekeeper === true) report.pass(CHECK, 'notarized, ticket stapled, accepted by Gatekeeper');
  else report.fail(CHECK, 'E_MAC_NOT_NOTARIZED', undefined, [!stapled && 'no stapled notarization ticket', gatekeeper !== true && `Gatekeeper: ${gatekeeper}`].filter(Boolean).join('\n'));
}

async function windows(app, report) {
  if (process.platform !== 'win32') return report.skip(CHECK, 'Authenticode check needs Windows');
  const ps = `(Get-AuthenticodeSignature -LiteralPath '${app.executable.replace(/'/g, "''")}').Status`;
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', ps]).catch((e) => ({ stdout: String(e.message) }));
  const status = String(stdout).trim();
  if (status === 'Valid') report.pass(CHECK, 'executable has a valid Authenticode signature');
  else report.fail(CHECK, 'E_WIN_NOT_SIGNED', `Authenticode status: ${status || 'unknown'}`);
}
