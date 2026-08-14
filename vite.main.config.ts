import path from 'node:path';
import * as fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// The CLI shim (src/shim/shim.mjs) is read at runtime by createShimDir from
// `app.getAppPath()/src/shim/shim.mjs`. When the app runs from the vite build
// output (dev `npm start` and e2e via `.vite/build/main.js`), app.getAppPath()
// is `.vite/build`, so the file must be copied there — the packaged asar
// already includes `src/`, so packaged builds are unaffected.
function copyShimToBuild(): Plugin {
  return {
    name: 'copy-shim-to-build',
    closeBundle() {
      const out = path.resolve(__dirname, '.vite/build/src/shim');
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(
        path.resolve(__dirname, 'src/shim/shim.mjs'),
        path.join(out, 'shim.mjs'),
      );
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [copyShimToBuild()],
  resolve: {
    alias: {
      // @xterm/headless 6.0.0 ships a broken "module" field (lib/xterm.mjs
      // does not exist; the real file lives in lib-headless/). Point straight
      // at the shipped ESM build until upstream fixes the package.
      '@xterm/headless': path.resolve(
        __dirname,
        'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs',
      ),
    },
  },
  build: {
    rollupOptions: {
      // node-pty is a native module: resolved from node_modules at runtime,
      // never bundled (forge's auto-unpack-natives handles packaging).
      external: ['node-pty'],
    },
  },
});
