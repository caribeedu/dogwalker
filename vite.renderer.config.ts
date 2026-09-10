import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite tags `<script type="module">` / stylesheet `<link>` with `crossorigin`.
 * Under Electron `loadFile` (file:// + asar) Chromium treats that as a CORS
 * fetch; there is no server to answer with ACAO, so the bundle never runs and
 * the window stays on the empty backgroundColor — a black/blank screen.
 */
function stripCrossOrigin(): Plugin {
  return {
    name: 'dogwalker-strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/(\s)crossorigin(="[^"]*")?/g, '');
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  // Relative asset URLs so file:// / asar resolution works in production.
  base: './',
  plugins: [react(), stripCrossOrigin()],
  build: {
    // Avoid injecting a modulepreload polyfill that also carries crossorigin.
    modulePreload: { polyfill: false },
  },
});
