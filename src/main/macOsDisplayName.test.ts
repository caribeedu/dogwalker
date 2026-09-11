import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plist = require('plist') as {
  parse: (xml: string) => Record<string, unknown>;
  build: (obj: Record<string, unknown>) => string;
};

/** Mirrors forge.config.ts postPackage stamping (keep in sync). */
const APP_DISPLAY_NAME = 'Dogwalker';

function stampDisplayName(info: Record<string, unknown>): void {
  info.CFBundleDisplayName = APP_DISPLAY_NAME;
  info.CFBundleName = APP_DISPLAY_NAME;
}

describe('macOS CFBundle display name', () => {
  it('replaces executableName-derived CFBundleDisplayName without touching the binary name', () => {
    const info = plist.parse(
      plist.build({
        CFBundleDisplayName: 'dogwalker',
        CFBundleName: 'dogwalker',
        CFBundleExecutable: 'dogwalker',
      }),
    );
    stampDisplayName(info);
    expect(info.CFBundleDisplayName).toBe('Dogwalker');
    expect(info.CFBundleName).toBe('Dogwalker');
    expect(info.CFBundleExecutable).toBe('dogwalker');
  });
});
