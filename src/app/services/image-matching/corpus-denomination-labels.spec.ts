 /*
 * corpus-denomination-labels.spec.ts
 * WHAT RESOLVING THE COIN'S ID COSTS THE MATCHER ON A REAL COLLECTION
 *
 * WHAT THIS FILE IS
 *
 * Every other spec for this change asks whether a rule is implemented. This
 * one asks what the change DOES to a collection, and the answer is a number
 * rather than a reassurance:
 *
 *   - the REAL importer is run over all seven coin accounts of the
 *     structurally faithful corpus in `testing/qif-corpus/` (457 coins);
 *   - every coin is linked against the REAL authored seed -- 1,161
 *     denominations under 61 issuers -- through the same
 *     `resolveIndexedDenomination` the import path uses;
 *   - his filename conventions produce the photographs: an obverse and a
 *     reverse per security, a deliberately uninformative "silent" shot per
 *     coin, and a slab-label shot;
 *   - and the whole lot is matched TWICE, with and without the resolved
 *     labels, and the two sets of decisions are compared file by file.
 *
 * THE ANSWER IS ZERO, AND ZERO IS THE RESULT WE WANTED
 *
 * Not one photograph changes which coin it lands on. That is not a weak
 * result; it is the one design §2 asks for:
 *
 *     "The image matcher getting worse. It identifies coins partly by
 *      denomination; a regression there means photos attaching to the wrong
 *      coin, which is expensive to notice and painful to undo."
 *
 * AND HERE IS *WHY* IT IS ZERO, BECAUSE THE NUMBER IS WORTHLESS WITHOUT IT
 *
 * *** FOR EVERY ONE OF THE 449 CORPUS COINS THAT LINK, THE LOOKUP'S LABEL IS
 * CHARACTER-IDENTICAL TO THE TEXT THE QIF IMPORTER STORED. *** The importer
 * writes the seed's own spellings -- '3CS', '50¢', '$20' -- so the coin side
 * reads the same string either way and nothing can move. The eight that do
 * not link (`8 Reales` x4, `5s`, blank x3) keep their text, which is also
 * the unchanged path.
 *
 * So this file proves NO REGRESSION, and it deliberately cannot prove the
 * change does anything: a corpus with no divergence between text and label
 * has nothing to say about divergence. The behaviour itself is pinned in
 * coin-denomination-label.spec.ts, on the state the CSV and Excel importers
 * really produce (`Half Dollar` stored, `50¢` linked).
 *
 * *** IF THIS FILE EVER FAILS, DO NOT ADJUST THE NUMBER. *** It means either
 * the seed's labels have moved away from what the importers store, or the
 * coin side has started reading something new. Both are findings about the
 * coin side has started reading something new. Both are findings about the
 * coin before anything is changed.
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

    // EXACTLY what the import path does: the coin's own text, the coin's own
    // country. Not a constant, and not the file's. (See the header of
    // denominations/denomination-index.ts.)
    for (const coin of inventory) {
      coins += 1;
      coin.denominationId =
        resolveIndexedDenomination(coin.denomination, coin.country, index).denominationId;
      if (coin.denominationId !== null) linked += 1;
    }

    const names = [
      ...photoFilenamesFor(account),                              // his obverse + reverse
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
    /* NON-VACUITY, and this file needs it more than most: if the fixture
     * stopped producing coins, or the seed stopped linking any of them, or
     * the filename builder returned nothing, "no photograph moved" would be
     * true of an empty set and this whole file would pass while measuring
     * air. Each number below is asserted exactly for that reason. */
    expect(CORPUS.coins).toBe(457);
    expect(CORPUS.linked).toBe(449);
    expect(CORPUS.decisions).toBeGreaterThan(1500);
    expect(CORPUS.attached).toBeGreaterThan(500);
    expect(denominationLabelSnapshot(SEED_DENOMINATIONS).size).toBeGreaterThan(1000);
  });

  it('moves not one photograph off the coin it was already on', () => {
    // The list, not a count -- a review has to be of the actual coins.
    expect(CORPUS.moved).toEqual([]);
  });
});
