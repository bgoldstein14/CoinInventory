/**
 * The server must serve the directory the Angular build actually writes. If
 * they drift (as when the application builder added a `browser/` level), the
 * build and route tests still pass but the app serves an empty page.
 *
 *   1. the server's path matches what angular.json tells the builder;
 *   2. the SPA fallback's index.html exists after a build (skipped when
 *      `dist/` is absent, but not when dist exists without the file).
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
 * The directory angular.json makes the builder write the browser bundle to.
 * `@angular/build:application` adds `browser/` below `outputPath` unless
 * `outputPath.browser` overrides it; the older `:browser` builder doesn't.
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
    // Only in the built app shell, so a stale file or listing still fails.
    expect(response.text).toContain('<app-root>');
  });
});
