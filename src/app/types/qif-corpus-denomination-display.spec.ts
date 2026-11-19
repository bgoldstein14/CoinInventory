/*
 * Runs the QIF importer over the corpus and renders every coin's denomination
 * through the grid formatter against the real seed, in three states:
 *
 *   BEFORE      the raw column, through formatDenominationDisplay
 *   UNMIGRATED  `denominationId` null on every coin
 *   MIGRATED    ids backfilled as migration 014 would
 *
 * UNMIGRATED must equal MIGRATED (backfilling ids must not rename coins).
 * BEFORE -> UNMIGRATED may change only by showing a matched row's label
 * (e.g. 'Trime' -> '3CS') or marking an unmatched value as `Other (...)`.
 */

import { describe, expect, it } from 'vitest';

import { QIF_ACCOUNTS, inventoryFor } from '../testing/qif-accounts.fixture';
import { SEED_DENOMINATIONS } from '../testing/seed-denominations.fixture';
import { denominationIndexFor, resolveIndexedDenomination } from '../services/denominations/denomination-index';
import { CoinRecord } from './coin.model';
import { coinDenominationDisplay, formatDenominationDisplay } from './inventory-columns';

interface Census {
  total: number;
  /** Coins whose cell reads exactly what it read before this change. */
  unchanged: number;
  /** '<before>  ->  <after>' -> count. The review list. */
  moved: Map<string, number>;
  /** Coins whose cell differs between the un-migrated and migrated states. */
  renamedByMigration: string[];
}

function census(): Census {
  const index = denominationIndexFor(SEED_DENOMINATIONS);
  const result: Census = { total: 0, unchanged: 0, moved: new Map(), renamedByMigration: [] };

  for (const account of QIF_ACCOUNTS) {
    for (const coin of inventoryFor(account)) {
      result.total += 1;

      // The raw column only.
      const before = formatDenominationDisplay(coin.denomination);

      // No id yet (the importer does not write one).
      const unmigrated = coinDenominationDisplay(coin, SEED_DENOMINATIONS);

      // After migration 014; sql-denomination-resolution-parity.spec.ts checks
      // the SQL assigns the same id this resolver finds.
      const migratedCoin: CoinRecord = {
        ...coin,
        denominationId: resolveIndexedDenomination(coin.denomination, coin.country, index).denominationId
      };
      const migrated = coinDenominationDisplay(migratedCoin, SEED_DENOMINATIONS);

      if (migrated !== unmigrated) {
        result.renamedByMigration.push(`${coin.denomination} / ${coin.country}: ${unmigrated} -> ${migrated}`);
      }

      if (before === unmigrated) {
        result.unchanged += 1;
      } else {
        const key = `${before}  ->  ${unmigrated}`;
        result.moved.set(key, (result.moved.get(key) ?? 0) + 1);
      }
    }
  }

  return result;
}

const CORPUS = census();

describe('the real corpus, through the grid cell', () => {
  it('is a sample worth measuring', () => {
    // Guards against the tests below passing vacuously.
    expect(CORPUS.total).toBeGreaterThan(400);
    expect(SEED_DENOMINATIONS.length).toBeGreaterThan(1000);
  });

  it('renames NOTHING when migration 014 runs', () => {
    expect(CORPUS.renamedByMigration).toEqual([]);
  });

  it('leaves all but a handful of cells reading exactly as before', () => {
    // Exact counts rather than a floor, so small regressions are caught.
    // Expected to change only when the corpus is regenerated.
    expect({ total: CORPUS.total, unchanged: CORPUS.unchanged }).toMatchInlineSnapshot(`
      {
        "total": 457,
        "unchanged": 452,
      }
    `);
  });

  it('names every value that does move, so the list can be reviewed', () => {
    // Change this list by changing the seed or alias table, not by relaxing a rule here.
    const moved = [...CORPUS.moved.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    expect(Object.fromEntries(moved)).toMatchInlineSnapshot(`
      {
        "5s  ->  Other (5s)": 1,
        "8 Reales  ->  Other (8 Reales)": 4,
      }
    `);
  });
});
