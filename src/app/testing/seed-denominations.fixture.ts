/*
 * The REAL denomination reference table, in a test.
 *
 * `server/migrations/seed-data/issuers-denominations.json` is the authored
 * seed: 61 issuers and 1,161 denominations. Migration 013 loads it, and
 * `GET /api/denominations` hands the result to the client as
 * `Denomination[]`. This fixture reproduces that journey IN FULL, off disk,
 * so a Node test can run the importers against the lookup a real machine
 * will hold.
 *
 * WHY NOT A HAND-WRITTEN LIST OF SIX ROWS
 * Because every interesting property of denomination resolution is a
 * property of the WHOLE table, and a six-row fixture has none of them:
 *
 *   - `Crown` is ambiguous only because Great Britain, Australia, New
 *     Zealand and Ireland all struck one. A fixture with one Crown in it
 *     resolves happily and proves the opposite of the truth.
 *   - `8 Reales` resolves across issuers only because the coin's country
 *     ('United States', per the QIF parser) names an issuer that does NOT
 *     have one. Both halves of that need the real table.
 *   - The number of QIF securities that resolve is EVIDENCE about this
 *     collection. Measured against a fixture, it is a measurement of the
 *     fixture.
 *
 * THE ONE RULE THAT MUST NOT DRIFT: `Denominations.Country`
 * The client does not have the Issuers table on the wire; that is deliberate
 * debt. What it has is `Denominations.Country`, which migration 013 fills
 * with
 *
 *     COALESCE(Issuer.IsoCode, LEFT(Issuer.Name, 100))
 *
 * -- 'MX' for Mexico, 'Roman Empire' for the Roman Empire -- and which the
 * client turns back into an issuer. That expression is copied here
 * deliberately and is the single thing to check if this fixture ever stops
 * matching the database: see `seed-sql.ts`, the INSERT INTO Denominations.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Denomination } from '../types/coin.model';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = resolve(HERE, '../../../server/migrations/seed-data/issuers-denominations.json');

interface SeedFile {
  issuers: { key: string; name: string; isoCode: string | null }[];
  denominations: { issuer: string; label: string; faceValue?: number | null }[];
}

/**
 * The seed as `GET /api/denominations` would return it.
 *
 * Ids are assigned the way `IDENTITY` will: issuers and denominations in
 * file order, starting at 1. Nothing downstream depends on a particular id,
 * only on two rows having DIFFERENT ones, so the exact numbering is free --
 * but keeping it deterministic means a failing assertion can be read.
 */
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
 * Built once per test process. The file is 1,161 rows of JSON and every
 * spec that wants it wants the same copy; rebuilding it per `describe`
 * would also hand out a new ARRAY IDENTITY each time, which silently
 * defeats the index cache the importers rely on and would make a
 * performance assertion measure the wrong thing.
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
