/*
 * collection-status.spec.ts
 * THE DISASTER THESE TESTS EXIST TO PREVENT
 * This feature adds a per-coin status so a collection can hold coins the owner
 * does NOT have — a want list. Everything about that is safe except one thing,
 * and that one thing would be catastrophic and silent:
 *
 *   A COIN WHOSE STATUS IS MISSING, EMPTY, MISSPELLED OR FROM A FUTURE
 *   VERSION MUST READ AS "OWNED".
 *
 * Every coin already in the database predates this field. Every old JSON
 * backup, every old CSV export, every hand-edited row has no status at all. If
 * any of those read as anything other than Owned, the coin drops out of the
 * totals, out of the insurance schedule, and visually out of the collection —
 * and nothing anywhere says so. The owner would open the app one morning and
 * find his collection worth less than it was, with no error to go on.
 *
 * So the normaliser is the load-bearing part of this module, and most of what
 * follows is about it. The rest pins the value set and the ownership rule,
 * because "which statuses mean I actually have the coin" is the question the
 * totals, the melt figure and the insurance export all delegate to here.
 */

import { describe, expect, it } from 'vitest';
import {
  COLLECTION_STATUSES,
  COLLECTION_STATUS_LABELS,
  COLLECTION_STATUS_OPTIONS,
  CollectionStatus,
  DEFAULT_COLLECTION_STATUS,
  collectionStatusLabel,
  heldCoins,
  isHeldInCollection,
  normalizeCollectionStatus
} from './collection-status';

describe('the status value set', () => {
  it('is exactly the five states this app models', () => {
    // Pinned as a literal rather than a length check so that ADDING a value is
    // a deliberate act with a test change attached, not something that happens
    // by accident in a merge. Each one is justified in the module header.
    expect([...COLLECTION_STATUSES]).toEqual(
      ['owned', 'wanted', 'ordered', 'for-sale', 'sold']
    );
  });

  it('defaults to owned', () => {
    // The single most important line in the feature. See the file header.
    expect(DEFAULT_COLLECTION_STATUS).toBe('owned');
  });

  it('stores lowercase tokens, never display text', () => {
    // The database column holds these strings verbatim. Tokens mean a label
    // can be reworded without a data migration — the same reason
    // CoinRecord.source stores 'quicken' rather than 'Quicken import'.
    for (const status of COLLECTION_STATUSES) {
      expect(status).toBe(status.toLowerCase());
      expect(status).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('gives every status a human label', () => {
    for (const status of COLLECTION_STATUSES) {
      expect(COLLECTION_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it('offers the dropdown options in the declared order', () => {
    expect(COLLECTION_STATUS_OPTIONS.map(o => o.value)).toEqual([...COLLECTION_STATUSES]);
    expect(COLLECTION_STATUS_OPTIONS.map(o => o.label)).toEqual(
      COLLECTION_STATUSES.map(s => COLLECTION_STATUS_LABELS[s])
    );
  });

  it('never fits the two "Duplicate" readings into one value', () => {
    // OpenNumismat has a Duplicate status. This app deliberately does not:
    // a duplicate is still a coin you OWN, so it is a property, not a state,
    // and making it a state would mean a duplicate could not also be For Sale
    // — which is the single most likely thing to be true of a duplicate.
    expect(COLLECTION_STATUSES).not.toContain('duplicate');
  });
});

describe('normalizeCollectionStatus — the "old data is Owned" guarantee', () => {
  it('maps undefined to owned', () => {
    // Every coin that existed before this feature. If this ever returns
    // anything else, the whole collection silently leaves the totals.
    expect(normalizeCollectionStatus(undefined)).toBe('owned');
  });

  it('maps null to owned', () => {
    // A NULL CollectionStatus column, which is what a row inserted by an older
    // build of the server would have before the migration runs.
    expect(normalizeCollectionStatus(null)).toBe('owned');
  });

  it('maps an empty or whitespace string to owned', () => {
    expect(normalizeCollectionStatus('')).toBe('owned');
    expect(normalizeCollectionStatus('   ')).toBe('owned');
  });

  it('maps an unrecognised value to owned rather than throwing it away', () => {
    // A typo in a CSV cell, or a status written by a FUTURE version of the app
    // that this build does not know about. Both must land on the safe answer.
    expect(normalizeCollectionStatus('wishlist')).toBe('owned');
    expect(normalizeCollectionStatus('Pass')).toBe('owned');
    expect(normalizeCollectionStatus(42)).toBe('owned');
    expect(normalizeCollectionStatus({})).toBe('owned');
  });

  it('accepts every known token unchanged', () => {
    for (const status of COLLECTION_STATUSES) {
      expect(normalizeCollectionStatus(status)).toBe(status);
    }
  });

  it('is forgiving about case and surrounding space', () => {
    // CSV cells are typed by humans and arrive with whatever casing and
    // padding a spreadsheet felt like adding.
    expect(normalizeCollectionStatus('  WANTED ')).toBe('wanted');
    expect(normalizeCollectionStatus('For-Sale')).toBe('for-sale');
  });

  it('accepts the spellings a human would actually type for For Sale', () => {
    // The stored token is 'for-sale', but the EXPORTED label is "For Sale" and
    // that is the text that comes back in on a re-import. A round trip that
    // silently turned every For Sale coin into an Owned one would be exactly
    // the quiet data loss this module exists to prevent.
    expect(normalizeCollectionStatus('For Sale')).toBe('for-sale');
    expect(normalizeCollectionStatus('for sale')).toBe('for-sale');
    expect(normalizeCollectionStatus('forsale')).toBe('for-sale');
  });
});

describe('isHeldInCollection — what "I have this coin" means', () => {
  it('counts an owned coin', () => {
    expect(isHeldInCollection({ collectionStatus: 'owned' })).toBe(true);
  });

  it('counts a coin that is for sale', () => {
    // Listing a coin does not remove it from the house. It is still yours,
    // still worth money, and still needs insuring until it actually sells.
    expect(isHeldInCollection({ collectionStatus: 'for-sale' })).toBe(true);
  });

  it('does NOT count a wanted coin', () => {
    // The whole point of the feature: a want-list coin must never inflate the
    // value of a collection the user does not have.
    expect(isHeldInCollection({ collectionStatus: 'wanted' })).toBe(false);
  });

  it('does NOT count an ordered coin', () => {
    // Bought but not in hand. The test is possession, not title: it is not on
    // the shelf, so it is not in the insurance schedule and not in the totals.
    expect(isHeldInCollection({ collectionStatus: 'ordered' })).toBe(false);
  });

  it('does NOT count a sold coin', () => {
    expect(isHeldInCollection({ collectionStatus: 'sold' })).toBe(false);
  });

  it('counts a coin with NO status at all', () => {
    // Legacy data again, from the other side. Every pre-feature coin reaches
    // this predicate with the key absent and must be counted.
    expect(isHeldInCollection({})).toBe(true);
    expect(isHeldInCollection({ collectionStatus: undefined })).toBe(true);
  });
});

describe('heldCoins', () => {
  const coin = (collectionStatus?: CollectionStatus, currentValue = 0) =>
    ({ collectionStatus, currentValue });

  it('keeps only the coins actually in the collection', () => {
    const list = [
      coin('owned', 10),
      coin('wanted', 100000),
      coin('for-sale', 20),
      coin('ordered', 500),
      coin('sold', 70),
      coin(undefined, 5)
    ];

    expect(heldCoins(list).map(c => c.currentValue)).toEqual([10, 20, 5]);
  });

  it('returns a new array and does not mutate the input', () => {
    const list = [coin('owned'), coin('wanted')];
    const result = heldCoins(list);
    expect(result).not.toBe(list);
    expect(list).toHaveLength(2);
  });
});

describe('collectionStatusLabel', () => {
  it('renders each status for a human', () => {
    expect(collectionStatusLabel('owned')).toBe('Owned');
    expect(collectionStatusLabel('wanted')).toBe('Wanted');
    expect(collectionStatusLabel('ordered')).toBe('Ordered');
    expect(collectionStatusLabel('for-sale')).toBe('For Sale');
    expect(collectionStatusLabel('sold')).toBe('Sold');
  });

  it('renders a missing status as Owned, never as a dash', () => {
    // A dash would say "unknown". It is not unknown — a coin with no status is
    // owned, and the grid must say so, or every pre-existing coin would look
    // like it had a gap in its record.
    expect(collectionStatusLabel(undefined)).toBe('Owned');
    expect(collectionStatusLabel('')).toBe('Owned');
  });
});
