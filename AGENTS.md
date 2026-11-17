# Working on electron-smoke

Zero-dependency Node CLI + GitHub Action that smoke tests packaged Electron apps.
Keep it zero runtime dependencies (devDependencies are fine) and Node >= 18.17 compatible.

## Layout
- `bin/electron-smoke.js`: CLI (argument parsing only)
- `src/index.js`: `smoke(target, options)` runs the checks per app
- `src/find-app.js`: finds apps in .app / unpacked dirs / .dmg / .AppImage
- `src/checks/{bundle,native,launch,signing}.js`: one file per check group
- `src/codes.js`: every finding code with its title and fix. The README table is generated from it
- `src/asar.js`, `src/binary.js`: minimal asar reader and Mach-O/ELF/PE header parser
- `action.yml`: composite action that runs the CLI from the checked-out action

## Rules
- Every new finding gets a code in `src/codes.js` with a concrete `fix`, then run `npm run docs`.
- Codes are a public API (users and agents match on them). Do not rename or remove one; add a new one.
- Every new failure mode gets an integration test in `test/integration.test.js` that builds a real app broken that way (see `test/fixtures.js`).
- Prefer warnings over failures for anything heuristic. A false failure on a working app is the worst bug this tool can have.
- `npm test` must pass on macOS, Windows and Linux (CI runs all three).
