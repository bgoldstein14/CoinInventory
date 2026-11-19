/**
 * Runs the Angular CLI after one warm-up esbuild call.
 *
 * Native binaries are blocked on this machine, so esbuild is aliased to
 * esbuild-wasm. Under wasm, esbuild detects Windows with an async probe and
 * marks the check done before it finishes; Angular starts two bundling
 * contexts at once, the second sees "not Windows" and fails with
 * 'The working directory "C:\..." is not an absolute path'.
 * One completed build first caches the answer, so concurrent contexts work.
 * With native esbuild this is a no-op. Safe to delete once the wasm alias goes.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Best-effort: if the warm-up fails, let the CLI run and report its own error.
try {
  await require('esbuild').build({
    stdin: { contents: 'export const warmUp = 1;', loader: 'js' },
    absWorkingDir: process.cwd(),
    write: false,
    logLevel: 'silent',
  });
} catch {
  // Ignored.
}

await import(pathToFileURL(require.resolve('@angular/cli/bin/ng.js')).href);
