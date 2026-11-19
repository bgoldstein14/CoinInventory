/*
 * Whole-app text scan for unguarded reads of `CoinRecord.imagePaths`, which is
 * absent on coins from `GET /api/coins` until their photos are loaded. The
 * compiler cannot catch this (no `strictNullChecks` or `strictTemplates`).
 *
 * Rule: templates must not mention `imagePaths`; code must read it with
 * `?? []`, `Array.isArray(...)` or an optional chain, or go through
 * services/coin-photos.ts (which falls back to `imageCount`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_ROOT = join(__dirname, '..');

function walk(dir: string, extension: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, extension, found);
    else if (entry.endsWith(extension)) found.push(full);
  }
  return found;
}

/** Strip HTML comments. */
function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Strip both comment styles from TypeScript. */
function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('no template reads imagePaths directly', () => {
  it('finds no mention of imagePaths in any component template', () => {
    const offenders: string[] = [];

    for (const file of walk(APP_ROOT, '.html')) {
      const body = stripHtmlComments(readFileSync(file, 'utf8'));
      if (body.includes('imagePaths')) offenders.push(relative(APP_ROOT, file));
    }

    // Templates should use a `photos()` computed (defaults to `[]`) or
    // `photoCount()` (falls back to `imageCount`) instead.
    expect(offenders).toEqual([]);
  });
});

describe('component code that does read imagePaths tolerates its absence', () => {
  it('guards every read with ?? [], Array.isArray or an optional chain', () => {
    // Only property access matters; locals/parameters named `imagePaths` are
    // already-resolved arrays.
    const PROPERTY_ACCESS = /\.imagePaths\b/;

    const allowedPatterns = [
      /\.imagePaths\s*\?\?\s*\[\]/,         // `coin.imagePaths ?? []`
      /Array\.isArray\([^)]*\.imagePaths/,  // `Array.isArray(coin.imagePaths)`
      /\.imagePaths\?\./,                   // `coin.imagePaths?.length`
      /\.imagePaths\s*=/,                   // writing the field, not reading it
      // CoinEditor guards this local with `Array.isArray` on the next line.
      /const imagePaths = payload\.imagePaths/,
    ];

    const offenders: string[] = [];

    for (const file of walk(APP_ROOT, '.ts')) {
      // Specs, the shared helpers and the type itself are exempt.
      if (file.endsWith('.spec.ts')) continue;
      if (file.endsWith('coin-photos.ts')) continue;
      if (file.endsWith('coin.model.ts')) continue;

      const body = stripTsComments(readFileSync(file, 'utf8'));
      for (const line of body.split('\n')) {
        if (!PROPERTY_ACCESS.test(line)) continue;
        if (allowedPatterns.some(pattern => pattern.test(line))) continue;
        offenders.push(`${relative(APP_ROOT, file)}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is not vacuous — it would catch an unguarded read', () => {
    // Proves the rule above actually matches a buggy line.
    const PROPERTY_ACCESS = /\.imagePaths\b/;
    const bug = 'return coin.imagePaths[0] ?? null;';

    expect(PROPERTY_ACCESS.test(bug)).toBe(true);
    expect(/\.imagePaths\s*\?\?\s*\[\]/.test(bug)).toBe(false);
    expect(/\.imagePaths\?\./.test(bug)).toBe(false);
  });
});
