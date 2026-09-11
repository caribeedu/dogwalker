import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

const SCHEME = 'dogwalker';

let registered = false;

/**
 * Serve the Vite renderer over a privileged custom scheme instead of file://.
 *
 * Packaged `loadFile` uses file:// inside the asar. Chromium's ES-module loader
 * (and CORS for module scripts) is unreliable on that origin, which presents as
 * a silent black window with no DevTools and no stderr. A standard-scheme
 * `dogwalker://` origin gives modules a real tuple origin and correct MIME.
 *
 * Must call {@link registerRendererSchemePrivileges} before app ready.
 */
export function registerRendererSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Register the protocol handler once app is ready. Idempotent. */
export function attachRendererProtocol(rendererRoot: string): void {
  if (registered) return;
  registered = true;

  const root = path.normalize(rendererRoot);
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const filePath = path.normalize(path.join(root, rel));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}

export function rendererIndexURL(): string {
  // Host is required for a standard scheme; path is what the handler reads.
  return `${SCHEME}://app/index.html`;
}
