/*
 * Tests for collection status. The key rule: a missing, empty, misspelled or
 * unknown status must read as "owned", otherwise legacy coins would silently
 * drop out of totals and the insurance schedule. Also pins the value set and
 * the "held in collection" rule used by totals, melt and insurance export.
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
    // Pinned as a literal so adding a status requires a test change.
    expect([...COLLECTION_STATUSES]).toEqual(
      ['owned', 'wanted', 'ordered', 'for-sale', 'sold']
    );
  });

  it('defaults to owned', () => {
    expect(DEFAULT_COLLECTION_STATUS).toBe('owned');
  });

  it('stores lowercase tokens, never display text', () => {
    // Stored verbatim in the database, so labels can change without a migration.
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
    // A duplicate is still owned (and may be For Sale), so it is not a status.
    expect(COLLECTION_STATUSES).not.toContain('duplicate');
  });
});

describe('normalizeCollectionStatus — the "old data is Owned" guarantee', () => {
  it('maps undefined to owned', () => {
    // Coins saved before the status field existed.
    expect(normalizeCollectionStatus(undefined)).toBe('owned');
  });

  it('maps null to owned', () => {
    // A NULL CollectionStatus column from an older server build.
    expect(normalizeCollectionStatus(null)).toBe('owned');
  });

  it('maps an empty or whitespace string to owned', () => {
    expect(normalizeCollectionStatus('')).toBe('owned');
    expect(normalizeCollectionStatus('   ')).toBe('owned');
  });

  it('maps an unrecognised value to owned rather than throwing it away', () => {
    // CSV typos or statuses from a newer version.
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
    expect(normalizeCollectionStatus('  WANTED ')).toBe('wanted');
    expect(normalizeCollectionStatus('For-Sale')).toBe('for-sale');
  });

  it('accepts the spellings a human would actually type for For Sale', () => {
    // Exports write the label "For Sale", so re-imports must accept it.
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
    // Still in hand and insured until it actually sells.
    expect(isHeldInCollection({ collectionStatus: 'for-sale' })).toBe(true);
  });

  it('does NOT count a wanted coin', () => {
    expect(isHeldInCollection({ collectionStatus: 'wanted' })).toBe(false);
  });

  it('does NOT count an ordered coin', () => {
    // Bought but not yet in hand; the rule is possession, not title.
    expect(isHeldInCollection({ collectionStatus: 'ordered' })).toBe(false);
  });

  it('does NOT count a sold coin', () => {
    expect(isHeldInCollection({ collectionStatus: 'sold' })).toBe(false);
  });

  it('counts a coin with NO status at all', () => {
    // Legacy coins have no status key.
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
    // No status means owned, not unknown.
    expect(collectionStatusLabel(undefined)).toBe('Owned');
    expect(collectionStatusLabel('')).toBe('Owned');
  });
});
