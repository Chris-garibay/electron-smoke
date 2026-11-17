// Regenerates the error-code table in README.md from src/codes.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { CODES } from '../src/codes.js';

const esc = (s) => s.replace(/\|/g, '\\|');
const level = (c) => ({ E: 'fails', W: 'warns', I: 'info' })[c[0]];
const rows = Object.entries(CODES).map(([code, d]) => `| \`${code}\` | ${level(code)} | ${esc(d.title)} | ${esc(d.fix)} |`);
const table = ['| Code | Effect | Meaning | Fix |', '|---|---|---|---|', ...rows].join('\n');

const readme = readFileSync('README.md', 'utf8');
const out = readme.replace(/(<!-- codes:start -->)[\s\S]*?(<!-- codes:end -->)/, `$1\n${table}\n$2`);
writeFileSync('README.md', out);
console.log(out === readme ? 'README codes already up to date' : 'README codes updated');
