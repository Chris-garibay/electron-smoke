// Every finding electron-smoke can report, with the fix to apply.
// Codes are stable: tools and AI agents can match on them.
// E_* fails the run. W_* is a warning. I_* is information.

export const CODES = {
  E_NO_APP_FOUND: {
    title: 'No packaged Electron app found',
    fix: 'Run your packager first (electron-builder, Electron Forge or electron-packager), then point electron-smoke at its output folder, e.g. `npx electron-smoke dist` or `npx electron-smoke out`.',
  },
  E_ASAR_UNREADABLE: {
    title: 'app.asar could not be read',
    fix: 'The archive is corrupt or truncated. Delete the output folder and package again.',
  },
  E_PACKAGE_JSON_MISSING: {
    title: 'package.json missing from the packaged app',
    fix: 'Your packager config excludes package.json. Remove the pattern that excludes it from `files` (electron-builder) or `ignore` (Forge/packager).',
  },
  E_MAIN_MISSING: {
    title: 'The "main" entry in package.json is not in the packaged app',
    fix: 'Make sure the build step that produces your main file runs before packaging, and that the `files`/`ignore` config does not exclude its folder (for electron-vite this is usually `out/`).',
  },
  E_DEP_MISSING: {
    title: 'The app crashed because a module is missing from the package',
    fix: 'Packagers copy only `dependencies` from package.json. Check the dependency is listed there (not only in devDependencies) and that `files`/`ignore` does not exclude node_modules. If your bundler inlines it, move it to devDependencies instead.',
  },
  E_EXPECTED_FILE_MISSING: {
    title: 'A file you required with --expect or --expect-resource is missing',
    fix: 'Check the build step that creates it ran, and that packager `files`, `extraResources` or `asarUnpack` config includes it.',
  },
  E_NATIVE_ARCH: {
    title: 'A native module was built for the wrong CPU architecture',
    fix: 'Rebuild native modules for the target arch: with electron-builder set `npmRebuild: true` and build with `--arm64`/`--x64`; otherwise run `npx @electron/rebuild --arch <arch>` before packaging. Do not reuse a node_modules folder installed for a different arch.',
  },
  E_NATIVE_LOAD: {
    title: 'A native module failed to load inside the packaged app',
    fix: 'If the error mentions NODE_MODULE_VERSION, the module was compiled for plain Node instead of Electron: run `npx @electron/rebuild` (electron-builder does this when `npmRebuild` is true). If it mentions a missing library or image, add the library to the package or unpack it with `asarUnpack`.',
  },
  E_BINARY_NOT_EXECUTABLE: {
    title: 'A bundled executable has no execute permission',
    fix: 'The file lost its +x bit (common when it was committed from Windows or copied by a script). Run `git update-index --chmod=+x <file>` or `chmod +x` it in a build hook before packaging.',
  },
  E_LAUNCH_EXITED: {
    title: 'The app exited during startup',
    fix: 'Read the captured output above. Run the packaged executable directly from a terminal with ELECTRON_ENABLE_LOGGING=1 to reproduce. Common causes: a missing file, a native module error, or code that only works in development (paths relative to the repo instead of `app.getAppPath()` / `process.resourcesPath`).',
  },
  E_MAIN_PROCESS_ERROR: {
    title: 'The main process threw an uncaught error',
    fix: 'Electron shows this as an error dialog to users. Fix the stack trace printed above. "Cannot find module" usually means a file or dependency was not packaged.',
  },
  E_MAIN_PROCESS_BLOCKED: {
    title: 'The main process never finished starting',
    fix: 'The process is alive but Chromium never started, so the main process is blocked. Usually an uncaught error at startup: Electron shows it in an "A JavaScript error occurred in the main process" dialog and prints nothing, so open the packaged app by hand to read the stack trace. Other causes: synchronous work that never returns, or a very slow first launch (raise --timeout).',
  },
  E_NO_WINDOW: {
    title: 'The app ran but never opened a window',
    fix: 'Check that `app.whenReady()` creates a BrowserWindow, that no single-instance lock or update check quits early, and raise --timeout if your app is legitimately slow to start. For tray-only apps pass --no-window.',
  },
  E_RENDERER_LOAD_FAILED: {
    title: 'The window opened but its page failed to load',
    fix: 'The window shows a Chromium error page. The HTML file or dev-server URL your main process loads is wrong in production. Use `loadFile(path.join(__dirname, ...))` for packaged builds and check the renderer output folder is packaged.',
  },
  E_RENDERER_CRASHED: {
    title: 'The renderer process crashed or reported a fatal error',
    fix: 'Read the captured output above. Look for preload script errors, a missing preload path, or a native module loaded in the renderer.',
  },
  E_MAC_SIGNATURE_INVALID: {
    title: 'The macOS app bundle signature is missing or invalid',
    fix: 'Unsigned or partly signed bundles are reported as "damaged" by macOS and may be moved to the Trash. Sign with a Developer ID (electron-builder `mac.identity`), or at minimum ad-hoc sign the whole bundle in an afterPack hook: `codesign --force --deep --sign - <App>.app`.',
  },
  E_MAC_NOT_NOTARIZED: {
    title: 'The macOS app is not notarized (required by --notarized)',
    fix: 'Notarize with an Apple Developer account: electron-builder `mac.notarize: true` with APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID set, or `@electron/notarize`.',
  },
  E_WIN_NOT_SIGNED: {
    title: 'The Windows executable has no valid Authenticode signature (required by --signed)',
    fix: 'Configure code signing in your packager (electron-builder `win.signtoolOptions` or Azure Trusted Signing). Unsigned apps trigger SmartScreen warnings.',
  },
  W_DEP_UNRESOLVED: {
    title: 'A dependency is referenced in app code but not packaged',
    fix: 'If the code that loads it runs on this platform, the app will crash with "Cannot find module". Check it is in `dependencies` (not devDependencies) and not excluded by packager config. Ignore this if the require() only runs on another OS or the bundler inlined the package.',
  },
  W_NATIVE_IN_ASAR: {
    title: 'A native module is packed inside app.asar',
    fix: 'Electron can load it by copying it to a temp folder, but this is slower and breaks modules that load sibling files. Add `**/*.node` to `asarUnpack` (electron-builder) or use `@electron-forge/plugin-auto-unpack-natives`.',
  },
  W_BINARY_ARCH: {
    title: 'A bundled executable does not match the app architecture',
    fix: 'Fine if your code picks the binary by `process.arch` at runtime. Otherwise it will fail to run (or run under Rosetta). Ship only the matching binary per build to save size.',
  },
  W_SECRET_FILE_SHIPPED: {
    title: 'A file that often holds secrets was packaged',
    fix: 'Anyone can unpack app.asar with `npx @electron/asar extract`. Exclude the file in packager config (e.g. `files: ["!**/.env*"]`) and load secrets another way.',
  },
  W_SOURCE_SHIPPED: {
    title: 'Source or dev files were packaged',
    fix: 'Exclude them in packager config to cut size, e.g. `files: ["!src/**", "!**/*.map", "!**/tsconfig*.json"]`.',
  },
  W_RUNTIME_SKIPPED: {
    title: 'Launch checks skipped for an app built for another OS',
    fix: 'Static checks still ran. Run electron-smoke on each target OS (a CI matrix) to launch every build.',
  },
  W_INSTALLER_SKIPPED: {
    title: 'Installer skipped because it can only be opened on its own OS',
    fix: '.dmg files are opened on macOS and .AppImage files on Linux. Point electron-smoke at the unpacked output folder instead, or run it on that OS.',
  },
  W_NATIVE_LOAD_SKIPPED: {
    title: 'Native module load test skipped',
    fix: 'The RunAsNode fuse is disabled in this app, so modules cannot be loaded outside the app. The launch check still catches load errors that happen at startup.',
  },
  I_OTHER_PLATFORM_BINARIES: {
    title: 'Binaries for other platforms are bundled',
    fix: 'Their paths name another OS or architecture, so the app most likely picks the right one at runtime. To save download size, ship only the binaries each build needs.',
  },
  I_MAC_ADHOC_SIGNED: {
    title: 'The macOS app is ad-hoc signed',
    fix: 'It will open on the machine that built it. Downloaded copies need `xattr -dr com.apple.quarantine <App>.app` or right-click → Open. Notarize to remove that step.',
  },
};

export function describe(code) {
  return CODES[code] ?? { title: code, fix: '' };
}
