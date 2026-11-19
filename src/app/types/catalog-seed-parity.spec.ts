/*
 * The seeded catalogue list exists in two places that must agree (the server
 * cannot import from src/): CATALOG_SEED in types/catalog-reference.ts and in
 * server/db/seed.ts. The server copy is read as text, because importing it
 * would pull `node:sqlite` into this test run.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CATALOG_SEED } from './catalog-reference';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQLITE_SEED_PATH = resolve(HERE, '../../../server/db/seed.ts');

/** The names in server/db/seed.ts's `CATALOG_SEED` array, in order. */
function sqliteSeedRows(source: string): string[] {
  const block = source.match(
    /export const CATALOG_SEED: readonly string\[\] = \[([\s\S]*?)\];/
  )?.[1];
  expect(block, 'no CATALOG_SEED array found in server/db/seed.ts').toBeTruthy();

  return [...(block ?? '').matchAll(/'((?:[^']|\\')*)'/g)].map(match => match[1]);
}

describe('the catalogue seed', () => {
  it('is the same in server/db/seed.ts as in the app', () => {
    expect(sqliteSeedRows(readFileSync(SQLITE_SEED_PATH, 'utf8'))).toEqual([...CATALOG_SEED]);
  });
});
