# electron-smoke

**Check that your packaged Electron app actually opens before you ship it.**

```sh
npx electron-smoke dist
```

`electron-smoke` takes the app your packager built (an `.app`, `.dmg`, `win-unpacked`, `linux-unpacked`, or experimentally an `.AppImage`), launches it the way a user would, and fails the build if it crashes, never opens a window, loads a missing page, ships native modules for the wrong CPU, leaves out files, or has a macOS signature that makes the app "damaged". Every failure comes with a stable code and the fix.

Zero dependencies. Works with electron-builder, Electron Forge and electron-packager. macOS, Windows and Linux.

---

## Why

Unit tests and `electron .` run your source tree. Users run the **packaged** app, and packaging breaks things that never break in development:

- a native module was compiled for x64 and the build is arm64
- a dependency sat in `devDependencies`, so the packager dropped it, and the app dies with `Cannot find module`
- `loadFile('index.html')` worked in dev but the renderer folder never made it into `app.asar`
- a bundled helper binary lost its execute bit
- the macOS bundle is unsigned, so Gatekeeper calls it "damaged" and offers to move it to the Trash
- a `.env` with real keys got packed into `app.asar`, where anyone can extract it

Every one of these passes CI with a green checkmark. Most Electron projects find them from user bug reports. Some projects hand-write a launch-the-artifact script for CI; `electron-smoke` is that script, finished and shared.

## Quick start

### GitHub Actions

Add one step after your packaging step:

```yaml
- run: npx electron-builder --publish never   # or: npm run make (Forge)
- uses: Chris-garibay/electron-smoke@v0
```

Test every OS you ship:

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx electron-builder --publish never
      - uses: Chris-garibay/electron-smoke@v0
        with:
          path: dist
          expect: |
            out/preload/index.js
            out/renderer/index.html
```

On Linux the action installs and uses a virtual display (`xvfb`). Failures show up as annotations on the run and as a table in the job summary.

### Command line

```sh
npx electron-smoke                    # looks in dist/, then out/, then release/
npx electron-smoke dist/mac-arm64/MyApp.app
npx electron-smoke dist/MyApp-1.2.0-arm64.dmg     # mounts it and tests what users install
npx electron-smoke out --timeout 60 --expect "out/renderer/**"
npx electron-smoke dist --json        # machine-readable: codes, messages, fixes
```

Exit code `0` means every check passed, `1` means at least one failed, `2` means bad arguments.

## What it checks

| Check | What happens | Catches |
|---|---|---|
| **launch** | Starts the packaged executable with Chromium's debugging endpoint, waits for a window, keeps it running a few seconds, then reads every page's state | crashes on start, uncaught main-process errors (including the silent "JavaScript error occurred" dialog), no window, page load failures, renderer and preload crashes, `Cannot find module` |
| **native** | Reads the CPU architecture of every `.node` module and bundled executable from its header, then loads each native module inside the packaged Electron runtime | wrong-arch builds, modules compiled for Node instead of Electron (`NODE_MODULE_VERSION`), helpers missing `+x`, natives packed inside `app.asar` |
| **bundle** | Reads `app.asar` (or `resources/app`) | missing `main` entry, runtime dependencies left out, files you list with `--expect`, `.env`/private keys shipped, source maps and TypeScript sources shipped |
| **signing** | macOS: `codesign --verify --deep --strict`, plus notarization and Gatekeeper with `--notarized`. Windows: Authenticode with `--signed` (experimental) | unsigned or partly signed bundles that macOS reports as damaged, missing notarization, unsigned Windows builds |

Universal macOS apps, apps that ship per-platform prebuilds (`prebuilds/darwin-x64/...`), VS Code-style `node_modules.asar` layouts and bundled apps (vite, webpack, esbuild) are handled, so large real-world apps pass cleanly: the static checks run against VS Code, Cursor, Postman, Arduino IDE and Claude Desktop report no false failures.

### Example output

From a real app with a stale, unsigned Intel build (trimmed, fix text wrapped):

```
Transcriber.app  darwin
  ✓ [bundle] main entry out/main/index.js is packaged
  ✓ [bundle] all 2 runtime dependencies are packaged
  ✓ [native] app binary is x64
  ✗ [signing] The macOS app bundle signature is missing or invalid (E_MAC_SIGNATURE_INVALID)
      │ Transcriber.app: code object is not signed at all
      fix: Unsigned or partly signed bundles are reported as "damaged" by macOS and may be
           moved to the Trash. Sign with a Developer ID (electron-builder `mac.identity`), or at
           minimum ad-hoc sign the whole bundle in an afterPack hook:
           `codesign --force --deep --sign - <App>.app`.
  ✓ [launch] window opened after 3.0s
  ✓ [launch] stayed up 3s with 1 page(s): app://out/renderer/index.html

electron-smoke: FAILED  6 passed, 1 failed, 0 warnings
```

## Options

| Flag | Action input | Default | Meaning |
|---|---|---|---|
| `[path]` | `path` | `dist`, `out`, `release` | Packager output folder, `.app`, unpacked folder, `.dmg` or `.AppImage` (experimental) |
| `--timeout <s>` | `timeout` | `30` | Seconds to wait for a window (doubled automatically for x64 builds under Rosetta) |
| `--stay <s>` | `stay` | `3` | Seconds the app must stay up after its window opens |
| `--expect <glob>` | `expect` | | File that must be inside the app (`app.asar` or `resources/app`). Repeatable / one per line |
| `--expect-resource <glob>` | `expect-resource` | | File that must be in `resources/` (`extraResources`). Repeatable / one per line |
| `--arg <value>` | `args` | | Extra argument passed to your app. Repeatable / one per line |
| `--no-window` | `no-window: true` | | Tray or background app: pass when the main process starts and stays up |
| `--no-launch` | `no-launch: true` | | Static checks only |
| `--no-native-load` | | | Skip loading native modules in the packaged runtime |
| `--sandbox` | | | Keep Chromium's sandbox on Linux (by default `--no-sandbox` is added, which CI containers need) |
| `--notarized` | `notarized: true` | | macOS: require notarization and Gatekeeper approval |
| `--signed` | `signed: true` | | Windows: require a valid Authenticode signature (experimental) |
| `--json` | | | Print results as JSON |
| `--report <file>` | output `report` | | Also write the JSON results to a file |

Your app is started with `ELECTRON_SMOKE=1` in its environment. Use it to skip auto-update checks, telemetry or first-run prompts during the test:

```js
if (!process.env.ELECTRON_SMOKE) autoUpdater.checkForUpdatesAndNotify();
```

## For AI coding agents

This section is written for AI assistants (Claude Code, Cursor, Copilot, Codex and others) working on an Electron project. It is also a useful checklist for humans.

**When to use it.** Whenever you create or change how an Electron app is packaged or released: an electron-builder or Forge config, a release workflow, `files`/`extraResources`/`asarUnpack`, native dependencies, signing, or the paths the main process loads. A passing `npm test` and a successful packaging step do not show that the packaged app starts. Run this before you tell the user a build or release is ready.

**How to run it.**

```sh
# after packaging (e.g. npx electron-builder --dir, or npm run package)
npx electron-smoke dist --json
```

In a GitHub workflow, add `- uses: Chris-garibay/electron-smoke@v0` after the packaging step, once per OS in the build matrix.

**How to read the result.** `--json` prints `{ ok, passed, failed, warnings, findings[] }`. Each finding has `level` (`pass`, `fail`, `warn`, `info`, `skip`), a stable `code`, a `message`, a `fix` and sometimes `details` with captured app output. Fix every `fail`. Each `fix` field says what to change; the [error codes](#error-codes) table below lists them all.

**Rules that keep the check meaningful:**

- Repackage and rerun after each fix; most fixes are packager config changes that only show up in a new build.
- Do not add `--no-launch`, `--no-native-load` or `--no-window` to make a failure go away. Use `--no-window` only for apps that really have no window.
- `E_MAIN_PROCESS_BLOCKED` means the app hit an uncaught error at startup. Electron shows it in a dialog and prints nothing; ask the user to open the packaged app and read the dialog, or check `app.isPackaged` code paths and paths built from `__dirname`.
- `W_*` warnings do not fail the run, but `W_SECRET_FILE_SHIPPED` should be raised with the user.

**Snippet for your project's agent instructions.** Paste this into `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` or `.github/copilot-instructions.md` in an Electron project:

```md
## Packaging
After any change to packaging, release workflows, native dependencies or startup code,
package the app and run `npx electron-smoke dist --json`. Fix every finding with
level "fail" (each includes a `fix`) before reporting the build as working.
```

## Error codes

Codes are stable across releases. `E_*` fails the run, `W_*` warns, `I_*` is information.

<!-- codes:start -->
| Code | Effect | Meaning | Fix |
|---|---|---|---|
| `E_NO_APP_FOUND` | fails | No packaged Electron app found | Run your packager first (electron-builder, Electron Forge or electron-packager), then point electron-smoke at its output folder, e.g. `npx electron-smoke dist` or `npx electron-smoke out`. |
| `E_ASAR_UNREADABLE` | fails | app.asar could not be read | The archive is corrupt or truncated. Delete the output folder and package again. |
| `E_PACKAGE_JSON_MISSING` | fails | package.json missing from the packaged app | Your packager config excludes package.json. Remove the pattern that excludes it from `files` (electron-builder) or `ignore` (Forge/packager). |
| `E_MAIN_MISSING` | fails | The "main" entry in package.json is not in the packaged app | Make sure the build step that produces your main file runs before packaging, and that the `files`/`ignore` config does not exclude its folder (for electron-vite this is usually `out/`). |
| `E_DEP_MISSING` | fails | The app crashed because a module is missing from the package | Packagers copy only `dependencies` from package.json. Check the dependency is listed there (not only in devDependencies) and that `files`/`ignore` does not exclude node_modules. If your bundler inlines it, move it to devDependencies instead. |
| `E_EXPECTED_FILE_MISSING` | fails | A file you required with --expect or --expect-resource is missing | Check the build step that creates it ran, and that packager `files`, `extraResources` or `asarUnpack` config includes it. |
| `E_NATIVE_ARCH` | fails | A native module was built for the wrong CPU architecture | Rebuild native modules for the target arch: with electron-builder set `npmRebuild: true` and build with `--arm64`/`--x64`; otherwise run `npx @electron/rebuild --arch <arch>` before packaging. Do not reuse a node_modules folder installed for a different arch. |
| `E_NATIVE_LOAD` | fails | A native module failed to load inside the packaged app | If the error mentions NODE_MODULE_VERSION, the module was compiled for plain Node instead of Electron: run `npx @electron/rebuild` (electron-builder does this when `npmRebuild` is true). If it mentions a missing library or image, add the library to the package or unpack it with `asarUnpack`. |
| `E_BINARY_NOT_EXECUTABLE` | fails | A bundled executable has no execute permission | The file lost its +x bit (common when it was committed from Windows or copied by a script). Run `git update-index --chmod=+x <file>` or `chmod +x` it in a build hook before packaging. |
| `E_LAUNCH_EXITED` | fails | The app exited during startup | Read the captured output above. Run the packaged executable directly from a terminal with ELECTRON_ENABLE_LOGGING=1 to reproduce. Common causes: a missing file, a native module error, or code that only works in development (paths relative to the repo instead of `app.getAppPath()` / `process.resourcesPath`). |
| `E_MAIN_PROCESS_ERROR` | fails | The main process threw an uncaught error | Electron shows this as an error dialog to users. Fix the stack trace printed above. "Cannot find module" usually means a file or dependency was not packaged. |
| `E_MAIN_PROCESS_BLOCKED` | fails | The main process never finished starting | The process is alive but Chromium never started, so the main process is blocked. Usually an uncaught error at startup: Electron shows it in an "A JavaScript error occurred in the main process" dialog and prints nothing, so open the packaged app by hand to read the stack trace. Other causes: synchronous work that never returns, or a very slow first launch (raise --timeout). |
| `E_NO_WINDOW` | fails | The app ran but never opened a window | Check that `app.whenReady()` creates a BrowserWindow, that no single-instance lock or update check quits early, and raise --timeout if your app is legitimately slow to start. For tray-only apps pass --no-window. |
| `E_RENDERER_LOAD_FAILED` | fails | The window opened but its page failed to load | The window shows a Chromium error page. The HTML file or dev-server URL your main process loads is wrong in production. Use `loadFile(path.join(__dirname, ...))` for packaged builds and check the renderer output folder is packaged. |
| `E_RENDERER_CRASHED` | fails | The renderer process crashed or reported a fatal error | Read the captured output above. Look for preload script errors, a missing preload path, or a native module loaded in the renderer. |
| `E_MAC_SIGNATURE_INVALID` | fails | The macOS app bundle signature is missing or invalid | Unsigned or partly signed bundles are reported as "damaged" by macOS and may be moved to the Trash. Sign with a Developer ID (electron-builder `mac.identity`), or at minimum ad-hoc sign the whole bundle in an afterPack hook: `codesign --force --deep --sign - <App>.app`. |
| `E_MAC_NOT_NOTARIZED` | fails | The macOS app is not notarized (required by --notarized) | Notarize with an Apple Developer account: electron-builder `mac.notarize: true` with APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID set, or `@electron/notarize`. |
| `E_WIN_NOT_SIGNED` | fails | The Windows executable has no valid Authenticode signature (required by --signed) | Configure code signing in your packager (electron-builder `win.signtoolOptions` or Azure Trusted Signing). Unsigned apps trigger SmartScreen warnings. |
| `W_DEP_UNRESOLVED` | warns | A dependency is referenced in app code but not packaged | If the code that loads it runs on this platform, the app will crash with "Cannot find module". Check it is in `dependencies` (not devDependencies) and not excluded by packager config. Ignore this if the require() only runs on another OS or the bundler inlined the package. |
| `W_NATIVE_IN_ASAR` | warns | A native module is packed inside app.asar | Electron can load it by copying it to a temp folder, but this is slower and breaks modules that load sibling files. Add `**/*.node` to `asarUnpack` (electron-builder) or use `@electron-forge/plugin-auto-unpack-natives`. |
| `W_BINARY_ARCH` | warns | A bundled executable does not match the app architecture | Fine if your code picks the binary by `process.arch` at runtime. Otherwise it will fail to run (or run under Rosetta). Ship only the matching binary per build to save size. |
| `W_SECRET_FILE_SHIPPED` | warns | A file that often holds secrets was packaged | Anyone can unpack app.asar with `npx @electron/asar extract`. Exclude the file in packager config (e.g. `files: ["!**/.env*"]`) and load secrets another way. |
| `W_SOURCE_SHIPPED` | warns | Source or dev files were packaged | Exclude them in packager config to cut size, e.g. `files: ["!src/**", "!**/*.map", "!**/tsconfig*.json"]`. |
| `W_RUNTIME_SKIPPED` | warns | Launch checks skipped for an app built for another OS | Static checks still ran. Run electron-smoke on each target OS (a CI matrix) to launch every build. |
| `W_INSTALLER_SKIPPED` | warns | Installer skipped because it can only be opened on its own OS | .dmg files are opened on macOS and .AppImage files on Linux. Point electron-smoke at the unpacked output folder instead, or run it on that OS. |
| `W_NATIVE_LOAD_SKIPPED` | warns | Native module load test skipped | The RunAsNode fuse is disabled in this app, so modules cannot be loaded outside the app. The launch check still catches load errors that happen at startup. |
| `I_OTHER_PLATFORM_BINARIES` | info | Binaries for other platforms are bundled | Their paths name another OS or architecture, so the app most likely picks the right one at runtime. To save download size, ship only the binaries each build needs. |
| `I_MAC_ADHOC_SIGNED` | info | The macOS app is ad-hoc signed | It will open on the machine that built it. Downloaded copies need `xattr -dr com.apple.quarantine <App>.app` or right-click → Open. Notarize to remove that step. |
<!-- codes:end -->

## Programmatic use

```js
import { smoke } from 'electron-smoke';

const result = await smoke('dist', { timeout: 60, expect: ['out/preload/*.js'], silent: true });
if (!result.ok) {
  for (const f of result.findings.filter((f) => f.level === 'fail')) console.error(f.code, f.message, f.fix);
}
```

## Works with your other tests

Playwright's `_electron.launch()` is the right tool for testing what your UI does. `electron-smoke` covers the step before that: whether the artifact you are about to upload is packaged correctly and starts at all, with no test code to write or maintain. Many projects run both.

## Limitations

- **Experimental:** `.AppImage` input and the Windows `--signed` check are implemented but not yet covered by CI. Everything else runs in CI on macOS, Windows and Linux against real Electron apps. Bug reports for the experimental parts are very welcome.
- Launch checks run on the OS the app was built for; static checks run anywhere. Use a CI matrix to launch every build.
- Windows `.exe`/`.msi` installers are not run. Point it at `win-unpacked` (electron-builder) or `out/<name>-win32-x64` (Forge).
- An app that enforces a single instance will quit if a copy is already running on the machine. CI runners start clean.
- The launch check finds windows through Chromium's `--remote-debugging-port`. Apps that reject unknown switches before Chromium starts are not supported.

## Development

```sh
npm install      # downloads Electron for the integration tests
npm test         # unit tests + real Electron apps broken on purpose, one per failure code
npm run docs     # regenerate the error code table above from src/codes.js
```

## License

MIT
