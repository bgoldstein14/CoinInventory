/**
 * ng-wasm-safe.mjs — runs the Angular CLI after priming esbuild once.
 *
 * WHY THIS EXISTS
 *
 * This machine's group policy will not execute native binaries, so
 * package.json pins `"esbuild": "npm:esbuild-wasm@0.28.1"`. The build system
 * (`@angular/build:application`) works through esbuild-wasm — with one
 * exception, and it is fatal.
 *
 * esbuild decides whether it is on Windows once per service process. Under
 * WebAssembly it cannot ask the host, so it guesses by opening "C:\\" — and
 * it sets the "I have already checked" flag BEFORE that check comes back.
 * Angular starts two bundling contexts at once (the application code and the
 * global stylesheet), so the second one reads the flag while the first one's
 * probe is still in flight, concludes it is on a POSIX system, and rejects
 * the workspace path:
 *
 *     ERROR  The working directory "C:\...\dev" is not an absolute path
 *
 * The build then fails in under a second, every time. It is a race, not a
 * configuration error: one esbuild call on its own always succeeds, two
 * started together do not. Reproduce it with two concurrent
 * `esbuild.context()` calls and nothing else.
 *
 * The fix is to let exactly one esbuild call finish before the CLI starts.
 * After that the answer is cached in the service process and any number of
 * concurrent contexts are fine. That is all this file does: one tiny build of
 * a one-line module held in memory, then the ordinary `ng` entry point, with
 * the arguments passed straight through.
 *
 * Native esbuild knows its own platform and never runs the probe, so on a
 * machine without the override this is a few milliseconds of no-op and the
 * CLI behaves exactly as it would have. Deleting this file is safe the day
 * the overrides go; until then, `ng build` run directly will fail here.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// Best-effort on purpose. If esbuild cannot be resolved or the warm-up
// itself fails, the CLI should still get its chance to run and report a real
// error of its own — this wrapper must never be the reason a build does not
// start.
try {
  await require('esbuild').build({
    stdin: { contents: 'export const warmUp = 1;', loader: 'js' },
    absWorkingDir: process.cwd(),
    write: false,
    logLevel: 'silent',
  });
} catch {
  // Ignored: see above.
}

await import(pathToFileURL(require.resolve('@angular/cli/bin/ng.js')).href);
