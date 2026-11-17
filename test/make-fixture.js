// Prints `path=<fixture app>` for the CI job that exercises action.yml.
import { makeApp, GOOD_MAIN, INDEX_HTML } from './fixtures.js';
const app = await makeApp({ 'main.js': GOOD_MAIN, 'index.html': INDEX_HTML }, { asar: true });
console.log(`path=${app.path}`);
