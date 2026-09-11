import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'fs-extra';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import MakerAppImage from '@reforged/maker-appimage';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const require = createRequire(import.meta.url);
const plist = require('plist') as {
  parse: (xml: string) => Record<string, unknown>;
  build: (obj: Record<string, unknown>) => string;
};

/** Human-facing macOS name; keep distinct from lowercase `executableName`. */
const APP_DISPLAY_NAME = 'Dogwalker';

/**
 * electron-packager sets CFBundleDisplayName from `executableName` (needed
 * lowercase for the Linux AppImage bin). Restore the branded display name so
 * Dock / Finder / menu bar show "Dogwalker", not "dogwalker".
 */
async function fixMacOsDisplayName(outputPath: string): Promise<void> {
  let appPath = outputPath;
  if (!appPath.endsWith('.app')) {
    const entries = await fs.readdir(appPath);
    const found = entries.find((e) => e.endsWith('.app'));
    if (!found) {
      throw new Error(`postPackage: no .app under ${outputPath}`);
    }
    appPath = path.join(appPath, found);
  }
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!(await fs.pathExists(infoPath))) {
    throw new Error(`postPackage: missing Info.plist at ${infoPath}`);
  }
  const parsed = plist.parse(await fs.readFile(infoPath, 'utf8'));
  parsed.CFBundleDisplayName = APP_DISPLAY_NAME;
  parsed.CFBundleName = APP_DISPLAY_NAME;
  // CFBundleExecutable must stay the lowercase binary name (`dogwalker`).
  await fs.writeFile(infoPath, plist.build(parsed));
}

/**
 * Native modules listed in Vite's `rollupOptions.external` are resolved from
 * node_modules at runtime and are NOT bundled into `.vite/build/main.js`. The
 * Forge Vite plugin also omits `node_modules` from the packaged asar, so each
 * external native must be copied in after the packager's file copy step —
 * otherwise the packaged app dies on launch with `Cannot find module '…'`.
 *
 * Keep this list in sync with `vite.main.config.ts` → `build.rollupOptions.external`.
 */
const EXTERNAL_NATIVE_MODULES = ['node-pty'] as const;

/**
 * Patch node-pty's unixTerminal.js so helperPath rewriting does not turn
 * `app.asar.unpacked/...` into `app.asar.unpacked.unpacked/...`.
 */
async function patchNodePtyUnixTerminal(nodePtyDest: string): Promise<void> {
  const unixPath = path.join(nodePtyDest, 'lib', 'unixTerminal.js');
  if (!(await fs.pathExists(unixPath))) return;
  let src = await fs.readFile(unixPath, 'utf8');
  if (src.includes("indexOf('app.asar.unpacked')")) return;

  const needle =
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
  const replacement =
    "if (helperPath.indexOf('app.asar.unpacked') === -1) " +
    "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
  if (!src.includes(needle)) {
    throw new Error(
      'node-pty unixTerminal.js helperPath rewrite not found — update packaging patch',
    );
  }
  src = src.replace(needle, replacement);

  const needle2 =
    "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
  const replacement2 =
    "if (helperPath.indexOf('node_modules.asar.unpacked') === -1) " +
    "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
  if (src.includes(needle2)) src = src.replace(needle2, replacement2);

  await fs.writeFile(unixPath, src);
}

const config: ForgeConfig = {
  packagerConfig: {
    name: APP_DISPLAY_NAME,
    // Unpack the whole node-pty tree (not just `*.node`): unixTerminal resolves
    // `spawn-helper` next to the native addon and rewrites `app.asar` →
    // `app.asar.unpacked`. Auto-unpack-natives alone only matches `*.node`.
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    // Force a stable lowercase executable name on every OS so the AppImage
    // maker's `bin` matches the packaged binary (it defaults to the capitalized
    // product name otherwise → "Could not find executable 'dogwalker'").
    // Note: packager also copies this into CFBundleDisplayName — fixed in
    // postPackage for darwin (see fixMacOsDisplayName).
    executableName: 'dogwalker',
    // App/program icon (from assets/logo.svg via tools/gen-icons.mjs). Packager
    // appends .ico on Windows and .icns on macOS; Linux icons come from the makers.
    icon: 'assets/icons/icon',
    // Ship the PNG as a runtime resource so the window/notification can load it
    // (the OS taskbar/dock icon already comes from `icon` above).
    extraResource: ['assets/icons/icon.png'],
  },
  // node-pty is N-API with bundled prebuilds (prebuilds/<platform>-<arch>),
  // so no electron-rebuild pass is needed — and requiring one would demand
  // native build tools on every dev machine. Linux falls back to the
  // install-time `build/Release` artifact, which N-API keeps Electron-compatible.
  rebuildConfig: { onlyModules: [] },
  hooks: {
    async postPackage(_forgeConfig, { platform, outputPaths }) {
      if (platform !== 'darwin') return;
      for (const out of outputPaths) await fixMacOsDisplayName(out);
    },
    async packageAfterCopy(_forgeConfig, buildPath) {
      const sourceRoot = path.resolve(process.cwd(), 'node_modules');
      const destRoot = path.join(buildPath, 'node_modules');
      await fs.ensureDir(destRoot);
      for (const name of EXTERNAL_NATIVE_MODULES) {
        const src = path.join(sourceRoot, name);
        const dest = path.join(destRoot, name);
        if (!(await fs.pathExists(src))) {
          throw new Error(
            `packageAfterCopy: missing ${name} at ${src} — run npm install before packaging`,
          );
        }
        await fs.copy(src, dest, {
          recursive: true,
          preserveTimestamps: true,
          // Drop nested installs under the package itself (src is already inside
          // the project's node_modules, so a naive path check would skip everything).
          filter: (p) => {
            const rel = path.relative(src, p);
            return rel === '' || !rel.split(path.sep).includes('node_modules');
          },
        });
        // npm/asar can leave prebuild helpers non-executable; macOS then fails
        // at runtime with `posix_spawnp failed` when spawning a PTY.
        const prebuilds = path.join(dest, 'prebuilds');
        if (await fs.pathExists(prebuilds)) {
          for (const plat of await fs.readdir(prebuilds)) {
            const helper = path.join(prebuilds, plat, 'spawn-helper');
            if (await fs.pathExists(helper)) await fs.chmod(helper, 0o755);
          }
        }
        const releaseHelper = path.join(dest, 'build', 'Release', 'spawn-helper');
        if (await fs.pathExists(releaseHelper)) await fs.chmod(releaseHelper, 0o755);

        // Guard against app.asar.unpacked → app.asar.unpacked.unpacked when the
        // native dir is already a real unpacked path (whole tree unpacked above).
        await patchNodePtyUnixTerminal(dest);
      }
    },
  },
  // Per-OS installers (PRODUCT.md §13, ROADMAP v0.8). Forge only runs makers
  // whose platform matches the host, so a given OS's CI job produces its own
  // artifact: Windows → Squirrel .exe, macOS → .dmg (+ .zip), Linux → .deb /
  // .rpm / AppImage.
  makers: [
    new MakerSquirrel({ setupIcon: 'assets/icons/icon.ico' }),
    new MakerDMG({ icon: 'assets/icons/icon.icns' }, ['darwin']),
    // ZIPs: macOS (Squirrel.Mac auto-update feed) + Windows (portable, for Scoop).
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerRpm({ options: { icon: 'assets/icons/icon.png' } }),
    new MakerDeb({ options: { icon: 'assets/icons/icon.png' } }),
    new MakerAppImage({ options: { bin: 'dogwalker', icon: 'assets/icons/icon.png' } }),
  ],
  plugins: [
    // Already a dependency; register it so any future external `.node` modules
    // are unpacked automatically (node-pty itself is covered by asar.unpack above).
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      // node-pty (and its spawn-helper) live in app.asar.unpacked. Keeping
      // OnlyLoadAppFromAsar would refuse those native loads at runtime.
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};

export default config;
