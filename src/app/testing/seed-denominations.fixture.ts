/*
 * The real denomination reference table, loaded from
 * `server/migrations/seed-data/issuers-denominations.json` and shaped as
 * `GET /api/denominations` returns it. Resolution behaviour (e.g. "Crown" being
 * ambiguous across issuers) only shows up against the whole table.
 *
 * `country` must match migration 013's `COALESCE(Issuer.IsoCode,
 * LEFT(Issuer.Name, 100))` (see the INSERT INTO Denominations in `seed-sql.ts`);
 * check that first if this fixture stops matching the database.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Denomination } from '../types/coin.model';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, '../../../server/db/seed-data/issuers-denominations.json');

interface SeedFile {
  issuers: { key: string; name: string; isoCode: string | null }[];
  denominations: { issuer: string; label: string; faceValue?: number | null }[];
}

/** The seed as `GET /api/denominations` would return it, with ids assigned in file order from 1. */
function buildSeedDenominations(): Denomination[] {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedFile;

  const issuerByKey = new Map(
    seed.issuers.map((issuer, index) => [issuer.key, { ...issuer, issuerId: index + 1 }])
  );

  return seed.denominations.map((row, index) => {
    const issuer = issuerByKey.get(row.issuer);
    return {
      denominationId: index + 1,
      label: row.label,
      // Migration 013's expression, verbatim. See the header.
      country: issuer ? (issuer.isoCode ?? issuer.name.slice(0, 100)) : '',
      sortOrder: index + 1,
      isActive: true,
      issuerId: issuer?.issuerId ?? null,
      issuerName: issuer?.name ?? null,
      faceValue: row.faceValue ?? null
    };
  });
}

/**
 * Built once per test process. A stable array identity matters: the importers
 * cache their index per array, so a fresh copy would defeat the cache.
 */
export const SEED_DENOMINATIONS: readonly Denomination[] = buildSeedDenominations();

/** Every label the seed lists for one issuer name, for readable assertions. */
export function seedLabelsForIssuer(issuerName: string): string[] {
  return SEED_DENOMINATIONS
    .filter(row => row.issuerName === issuerName)
    .map(row => row.label);
}

/** The seeded row with this label under this issuer, or undefined. */
export function seedDenomination(issuerName: string, label: string): Denomination | undefined {
  return SEED_DENOMINATIONS.find(row => row.issuerName === issuerName && row.label === label);
}
