 /*
 * Regression check: runs the QIF corpus (457 coins, seven accounts) through
 * the real importer, links each coin against the real denomination seed, and
 * matches the generated photo filenames with and without resolved labels.
 * No photo should change coin or tier: the QIF importer stores the seed's own
 * spellings ('3CS', '50¢'), so label and text are identical. The behaviour
 * when they differ is covered in coin-denomination-label.spec.ts.
 *
 * A failure means seed labels have drifted from what importers store, or the
 * coin side reads something new; investigate rather than adjusting numbers.
  */

import { describe, expect, it } from 'vitest';

import {
  QIF_ACCOUNTS,
  inventoryFor,
  photoFilenamesFor,
  silentPhotoFilenamesFor
} from '../../testing/qif-accounts.fixture';
import { SEED_DENOMINATIONS } from '../../testing/seed-denominations.fixture';
import {
  denominationIndexFor,
  resolveIndexedDenomination
} from '../denominations/denomination-index';
import { ImageMatchingService } from '../image-matching.service';
import { denominationLabelSnapshot } from './coin-signature';
import type { CoinRecord } from '../../types/coin.model';

interface Census {
  /** One entry per decision, `<account>|<filename>` -> what was decided. */
  readonly moved: string[];
  readonly decisions: number;
  readonly coins: number;
  readonly linked: number;
  readonly attached: number;
}

function census(): Census {
  const index = denominationIndexFor(SEED_DENOMINATIONS);
  const labels = denominationLabelSnapshot(SEED_DENOMINATIONS);
  const service = new ImageMatchingService();

  const moved: string[] = [];
  let decisions = 0;
  let coins = 0;
  let linked = 0;
  let attached = 0;

  for (const account of QIF_ACCOUNTS) {
    const inventory: CoinRecord[] = inventoryFor(account);

    // Resolve as the import path does: the coin's own text and country.
    for (const coin of inventory) {
      coins += 1;
      coin.denominationId =
        resolveIndexedDenomination(coin.denomination, coin.country, index).denominationId;
      if (coin.denominationId !== null) linked += 1;
    }

    const names = [
      ...photoFilenamesFor(account),                              // obverse + reverse
      ...silentPhotoFilenamesFor(account),                        // the shot that says less
      ...photoFilenamesFor(account, ['Slab Label'])               // a label, which never identifies
    ];

    const before = service.matchImages([...names], inventory);
    const after = service.matchImages([...names], inventory, labels);

    for (let i = 0; i < before.length; i++) {
      decisions += 1;
      if (after[i].matchedRecordId !== null) attached += 1;
      if (
        before[i].matchedRecordId !== after[i].matchedRecordId ||
        before[i].tier !== after[i].tier
      ) {
        moved.push(
          `${account.account} :: ${after[i].parsed.fileName} :: ` +
          `${before[i].tier}/${before[i].matchedRecordId ?? '-'} -> ` +
          `${after[i].tier}/${after[i].matchedRecordId ?? '-'}`
        );
      }
    }
  }

  return { moved, decisions, coins, linked, attached };
}

const CORPUS = census();

describe('the QIF corpus, matched with and without the resolved denomination', () => {
  it('is a sample worth measuring', () => {
    // Guards against the next test passing vacuously on an empty sample.
    expect(CORPUS.coins).toBe(457);
    expect(CORPUS.linked).toBe(449);
    expect(CORPUS.decisions).toBeGreaterThan(1500);
    expect(CORPUS.attached).toBeGreaterThan(500);
    expect(denominationLabelSnapshot(SEED_DENOMINATIONS).size).toBeGreaterThan(1000);
  });

  it('moves not one photograph off the coin it was already on', () => {
    // Compared as a list so a failure names the files.
    expect(CORPUS.moved).toEqual([]);
  });
});
