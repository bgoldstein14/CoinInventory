/*
 * qif-corpus-denomination-display.spec.ts — WHAT THE READ PATH DOES TO A
 * REAL COLLECTION.
 *
 * Every other spec for the denomination display rule asks whether it is
 * implemented. This one asks what it DOES to a whole collection, which
 * cannot be checked against six invented rows. So the real QIF importer is
 * run over the structurally faithful corpus in `testing/qif-corpus/`, and
 * every coin it produces is rendered through the grid's own cell formatter
 * against the real authored seed — over a thousand denominations under
 * dozens of issuers — in three states:
 *
 *   BEFORE     the raw column, through formatDenominationDisplay.
 *   UNMIGRATED with `DenominationId` NULL on every coin.
 *   MIGRATED   once the ids have been backfilled.
 *
 * WHAT COUNTS AS A FAILURE HERE, AND WHAT DOES NOT
 *
 * *** UNMIGRATED === MIGRATED IS THE HARD REQUIREMENT. *** If those two ever
 * differ, backfilling the ids renames coins on screen. There is no
 * acceptable number of those.
 *
 * BEFORE -> UNMIGRATED is allowed to move, and is EXPECTED to, in exactly
 * two directions:
 *
 *   a value that NAMES A ROW reads as that row's Label. '3CS' instead of
 *   'Trime'; '5 sh (Crown)' instead of '5s'. The coin editor has always
 *   shown it that way, and the grid disagreeing with the editor about the
 *   same coin is the whole problem.
 *
 *   a value that names NOTHING reads as unresolved rather than as a bare
 *   string. `Other (8 Reales)` is not a loss of information — the text is
 *   right there — it is the app admitting it has not been able to file the
 *   coin, which is how the user finds the rows worth their attention.
 *
 * Both lists are printed below rather than merely counted, because "14
 * coins changed" is not reviewable and "every British coin changed" would
 * be a finding.
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

      // The grid, as it was: the column, nothing else.
      const before = formatDenominationDisplay(coin.denomination);

      // The grid, as it is now, on the owner's database TODAY. Note the id
      // is not merely absent from the fixture — the importer does not write
      // one, and migration 014 has not run.
      const unmigrated = coinDenominationDisplay(coin, SEED_DENOMINATIONS);

      // The grid after migration 014. The id it will write is the one this
      // resolver finds; sql-denomination-resolution-parity.spec.ts holds
      // that the SQL never sets an id this would not.
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
    // Non-vacuity. If the fixture stops producing coins, or the seed stops
    // loading, every count below goes to zero and every assertion about
    // them becomes trivially true.
    expect(CORPUS.total).toBeGreaterThan(400);
    expect(SEED_DENOMINATIONS.length).toBeGreaterThan(1000);
  });

  it('renames NOTHING when migration 014 runs', () => {
    // THE PROMISE. The owner has been told the migration is invisible; this
    // is the evidence. A failure here is not a tuning problem — it means a
    // coin he is looking at today will say something else tomorrow.
    expect(CORPUS.renamedByMigration).toEqual([]);
  });

  it('leaves all but a handful of cells reading exactly as before', () => {
    // EXACT, not a floor. The sibling spec
    // (services/denominations/qif-corpus-denomination-links.spec.ts) makes
    // the same choice and gives the reason: a floor such as "at least 90%
    // unchanged" goes on passing through precisely the regression this is
    // written to catch. These counts moved once already during this work.
    //
    // If you regenerate the corpus they move with it, and that is expected.
    // Moving them for any other reason is a finding that wants explaining.
    expect({ total: CORPUS.total, unchanged: CORPUS.unchanged }).toMatchInlineSnapshot(`
      {
        "total": 457,
        "unchanged": 452,
      }
    `);
  });

  it('names every value that does move, so the list can be reviewed', () => {
    // *** READ THIS BEFORE "FIXING" THE LIST. ***
    // Each entry is a value the lookup CAN name, now shown under the name
    // the lookup gives it -- the same name the coin editor has always shown
    // for that coin. Nothing here is a loss: the text is untouched in the
    // column and visible the moment the coin is opened.
    //
    // The way to change this list is to change the seed or the alias table,
    // both of which have their own tests. It is NOT to relax a rule here.
    const moved = [...CORPUS.moved.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    expect(Object.fromEntries(moved)).toMatchInlineSnapshot(`
      {
        "5s  ->  Other (5s)": 1,
        "8 Reales  ->  Other (8 Reales)": 4,
      }
    `);
  });
});
