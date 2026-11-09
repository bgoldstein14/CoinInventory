/*
 * no-unguarded-image-paths.spec.ts — a whole-repository guard.
 * `CoinRecord.imagePaths` is OPTIONAL. It is absent on every coin that came
 * from `GET /api/coins` and has not been opened, because the list endpoint
 * stopped carrying photographs when a 105-coin collection made its response
 * impossible to serialise (see server/routes/coins/list-query.ts).
 *
 * So `coin.imagePaths.length` throws, and `coin.imagePaths[0]` is undefined,
 * on the normal startup state of the app.
 *
 * WHY A TEXT SCAN RATHER THAN THE COMPILER
 * Because the compiler does not catch it. This project's tsconfig does not
 * enable `strict` (and therefore not `strictNullChecks`) and does not enable
 * `strictTemplates`, so `coin.imagePaths.length` on an optional property
 * compiles perfectly happily in both TypeScript and Angular templates, and
 * fails at runtime in front of the user.
 *
 * Nine files read this field before the migration. A reviewer cannot be
 * expected to remember the rule, and `npx ngc` will not remind them. This
 * scan will.
 *
 * THE RULE
 * Templates must not mention `imagePaths` at all. Component code may, but
 * only in a form that tolerates absence: `?? []`, `Array.isArray(...)`, or
 * an optional chain. Anything else should go through
 * services/coin-photos.ts, which is the one place the fallback to
 * `imageCount` is written.
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

/** Strip HTML comments, which is where the explanations live. */
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

    /* A template is the worst place for this, for two reasons: the Angular
     * compiler will not type-check it under this project's settings, and the
     * failure arrives as a blank screen with a console error rather than as
     * anything a user can act on. Every template that needs photographs now
     * reads a `photos()` computed (which defaults to `[]`) or a
     * `photoCount()` helper (which falls back to `imageCount`). */
    expect(offenders).toEqual([]);
  });
});

describe('component code that does read imagePaths tolerates its absence', () => {
  it('guards every read with ?? [], Array.isArray or an optional chain', () => {
    /* Only PROPERTY ACCESS is interesting — `something.imagePaths`. A local
     * variable or parameter that happens to be called `imagePaths` (the
     * registry's `enrich(imagePaths)`, the attach callback's argument) is a
     * plain `string[]` that its caller has already resolved, and has nothing
     * to do with the optional field on CoinRecord. */
    const PROPERTY_ACCESS = /\.imagePaths\b/;

    const allowedPatterns = [
      /\.imagePaths\s*\?\?\s*\[\]/,         // `coin.imagePaths ?? []`
      /Array\.isArray\([^)]*\.imagePaths/,  // `Array.isArray(coin.imagePaths)`
      /\.imagePaths\?\./,                   // `coin.imagePaths?.length`
      /\.imagePaths\s*=/,                   // writing the field, not reading it
      // CoinEditor reads `payload.imagePaths` into a local and guards it with
      // `Array.isArray` on the very next line. Allowed by name because the
      // guard cannot fit on the same line.
      /const imagePaths = payload\.imagePaths/,
    ];

    const offenders: string[] = [];

    for (const file of walk(APP_ROOT, '.ts')) {
      // Specs deliberately build and inspect both shapes; that is their job.
      if (file.endsWith('.spec.ts')) continue;
      // The shared helpers and the type itself are where the rule is DEFINED.
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
    /* The scan above passes trivially if its regex never matches anything.
     * This runs the same rule over a line that IS the bug, to prove the rule
     * has teeth. */
    const PROPERTY_ACCESS = /\.imagePaths\b/;
    const bug = 'return coin.imagePaths[0] ?? null;';

    expect(PROPERTY_ACCESS.test(bug)).toBe(true);
    expect(/\.imagePaths\s*\?\?\s*\[\]/.test(bug)).toBe(false);
    expect(/\.imagePaths\?\./.test(bug)).toBe(false);
  });
});
