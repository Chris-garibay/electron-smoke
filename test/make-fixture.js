// Builds a working fixture app for the CI job that exercises action.yml and
// writes `path=<app>` to $GITHUB_OUTPUT (stdout may contain download noise).
import { appendFileSync } from 'node:fs';
import { makeApp, GOOD_MAIN, INDEX_HTML } from './fixtures.js';

const app = await makeApp({ 'main.js': GOOD_MAIN, 'index.html': INDEX_HTML }, { asar: true });
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `path=${app.path}\n`);
console.log(`fixture app: ${app.path}`);
