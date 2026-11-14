/**
 * dist-path.spec.ts — the server must serve the directory the Angular build
 * actually writes.
 *
 * This file exists because of a failure that no other test in either suite
 * can see. `server.ts` serves the built app with `express.static` and sends
 * `index.html` from the same folder for every non-API route. The server
 * specs drive that app with supertest against routes; they never look at the
 * built bundle, so if the two paths drift apart every one of them still
 * passes while the real app serves an empty page.
 *
 * The drift is not hypothetical: migrating from the deprecated webpack
 * builder (`@angular-devkit/build-angular:browser`) to
 * `@angular/build:application` moved the output from
 * `dist/coin-inventory-app/` to `dist/coin-inventory-app/browser/`. The build
 * succeeds either way.
 *
 * So the two tests below check the two halves of that contract:
 *
 *   1. the path the server computes is the path angular.json tells the
 *      builder to write — read from angular.json, not copied from it, so
 *      changing the builder's outputPath alone fails here; and
 *   2. the file the SPA fallback sends really is on disk after a build.
 *
 * (2) needs a build to have run, so it is skipped — loudly — when `dist/` is
 * absent entirely. It is NOT skipped when `dist/` exists but the file does
 * not: that is exactly the silent failure this file is here to catch.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';

import { angularDistPath, app } from './server';

const repoRoot = path.resolve(__dirname, '..');
const angularJsonPath = path.join(repoRoot, 'angular.json');

interface BuildTarget {
  builder: string;
  options: {
    outputPath: string | { base: string; browser?: string };
  };
}

function readBuildTarget(): BuildTarget {
  const raw = fs.readFileSync(angularJsonPath, 'utf8');
  const config = JSON.parse(raw);

  return config.projects['coin-inventory-app'].architect.build as BuildTarget;
}

/**
 * The absolute directory angular.json makes the builder write the browser
 * bundle to.
 *
 * `@angular/build:application` adds a `browser/` level below `outputPath`
 * unless `outputPath.browser` overrides it (`""` restores the old flat
 * layout). The older `:browser` builder has no such level at all. Working
 * that out from the config — rather than hard-coding today's answer — is
 * what makes this test survive the next builder change.
 */
function expectedBrowserOutputDir(target: BuildTarget): string {
  const { outputPath } = target.options;

  if (typeof outputPath === 'string') {
    return path.resolve(repoRoot, outputPath);
  }

  const base = path.resolve(repoRoot, outputPath.base);
  const browser = outputPath.browser ?? 'browser';

  return browser === '' ? base : path.join(base, browser);
}

describe('the directory the server serves the built app from', () => {
  it('is the directory angular.json makes the build write to', () => {
    const target = readBuildTarget();

    expect(angularDistPath).toBe(expectedBrowserOutputDir(target));
  });

  it('holds the index.html the SPA fallback sends, once a build has run', () => {
    const distRoot = path.join(repoRoot, 'dist');

    if (!fs.existsSync(distRoot)) {
      console.warn(
        `[dist-path.spec] skipped: no build output at ${distRoot}. ` +
          'Run "npm run build" to let this test check the real bundle.',
      );

      return;
    }

    const indexHtml = path.join(angularDistPath, 'index.html');

    expect(
      fs.existsSync(indexHtml),
      `The build wrote to ${distRoot} but the server sends ${indexHtml}, ` +
        'which does not exist. express.static is serving nothing.',
    ).toBe(true);
  });

  it('actually serves that app at "/", once a build has run', async () => {
    const distRoot = path.join(repoRoot, 'dist');

    if (!fs.existsSync(distRoot)) {
      console.warn(
        `[dist-path.spec] skipped: no build output at ${distRoot}. ` +
          'Run "npm run build" to let this test check the real bundle.',
      );

      return;
    }

    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    // The one tag that is only in the built app shell, so a 200 carrying
    // something else — a stale file, a directory listing — still fails.
    expect(response.text).toContain('<app-root>');
  });
});
