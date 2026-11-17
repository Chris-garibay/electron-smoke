// Collects findings and prints them for humans, GitHub Actions and JSON.

import { appendFileSync } from 'node:fs';
import { describe } from './codes.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const ICON = { pass: c(32, '✓'), fail: c(31, '✗'), warn: c(33, '!'), info: c(36, 'i'), skip: c(90, '-') };
const inActions = process.env.GITHUB_ACTIONS === 'true';

export class Reporter {
  constructor({ json = false, silent = false } = {}) {
    this.json = json;
    this.silent = silent;
    /** @type {Array<{app: string, check: string, level: string, code?: string, message: string, fix?: string, details?: string}>} */
    this.findings = [];
    this.app = '';
  }

  section(app) {
    this.app = app;
    if (!this.json && !this.silent) console.log(`\n${c(1, app)}`);
  }

  #add(level, check, message, code, details) {
    const d = code ? describe(code) : null;
    const f = { app: this.app, check, level, message, ...(code && { code, title: d.title, fix: d.fix }), ...(details && { details }) };
    this.findings.push(f);
    if (this.json || this.silent) return;
    console.log(`  ${ICON[level]} ${c(90, `[${check}]`)} ${message}${code ? c(90, ` (${code})`) : ''}`);
    if (details) console.log(indent(details, '      │ '));
    if (d?.fix && level !== 'pass') console.log(`      ${c(90, 'fix:')} ${d.fix}`);
    if (inActions && (level === 'fail' || level === 'warn')) {
      const kind = level === 'fail' ? 'error' : 'warning';
      console.log(`::${kind} title=electron-smoke ${code ?? check}::${escape(`${this.app}: ${message}. Fix: ${d?.fix ?? ''}`)}`);
    }
  }

  pass(check, message) { this.#add('pass', check, message); }
  fail(check, code, message, details) { this.#add('fail', check, message ?? describe(code).title, code, details); }
  warn(check, code, message, details) { this.#add('warn', check, message ?? describe(code).title, code, details); }
  info(check, code, message) { this.#add('info', check, message ?? describe(code).title, code); }
  skip(check, message) { this.#add('skip', check, message); }

  get failed() {
    return this.findings.some((f) => f.level === 'fail');
  }

  finish() {
    const count = (l) => this.findings.filter((f) => f.level === l).length;
    const summary = { ok: !this.failed, passed: count('pass'), failed: count('fail'), warnings: count('warn') };
    if (this.silent) {
      // programmatic use: caller reads the returned findings
    } else if (this.json) {
      console.log(JSON.stringify({ ...summary, findings: this.findings }, null, 2));
    } else {
      const line = `${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`;
      console.log(`\n${summary.ok ? c(32, 'electron-smoke: OK') : c(31, 'electron-smoke: FAILED')}  ${line}`);
      if (!summary.ok) console.log(c(90, 'Each failure above lists a fix. Codes are documented at https://github.com/Chris-garibay/electron-smoke#error-codes'));
    }
    if (process.env.GITHUB_STEP_SUMMARY && !this.silent) writeStepSummary(summary, this.findings);
    return { ...summary, findings: this.findings };
  }
}

function indent(text, prefix) {
  return text.trimEnd().split('\n').slice(-40).map((l) => prefix + l).join('\n');
}

function escape(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function writeStepSummary(summary, findings) {
  const icon = { pass: '✅', fail: '❌', warn: '⚠️', info: 'ℹ️', skip: '⏭️' };
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = findings
    .filter((f) => f.level !== 'pass' || summary.failed === 0)
    .map((f) => `| ${icon[f.level]} | ${cell(f.app)} | ${cell(f.check)} | ${cell(f.message)} | ${f.code ? `\`${f.code}\`` : ''} | ${f.level === 'pass' ? '' : cell(f.fix)} |`);
  const md = [
    `### electron-smoke: ${summary.ok ? 'passed' : 'failed'}`,
    `${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
    '',
    '| | App | Check | Result | Code | Fix |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  } catch {}
}
