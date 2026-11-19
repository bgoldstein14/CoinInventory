/**
 * The collection status tokens and normalizer, plus a check that the server's
 * copy of the list matches src/app/types/collection-status.ts (the server
 * project can't import from src/).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  COLLECTION_STATUSES,
  DEFAULT_COLLECTION_STATUS,
  MAX_COLLECTION_STATUS_LENGTH,
  normalizeCollectionStatus,
} from './collection-status';

describe('the status tokens', () => {
  it('is exactly the five states the app models', () => {
    expect([...COLLECTION_STATUSES]).toEqual(['owned', 'wanted', 'ordered', 'for-sale', 'sold']);
  });

  it('defaults to owned', () => {
    expect(DEFAULT_COLLECTION_STATUS).toBe('owned');
  });

  it('every token fits the NVARCHAR(20) column', () => {
    // A token must fit the column width.
    for (const status of COLLECTION_STATUSES) {
      expect(status.length).toBeLessThanOrEqual(MAX_COLLECTION_STATUS_LENGTH);
    }
  });
});

describe('normalizeCollectionStatus', () => {
  it('never returns null or undefined, whatever it is given', () => {
    // The column is NOT NULL. A null parameter aborts the INSERT.
    for (const input of [undefined, null, '', '   ', 42, {}, [], true]) {
      expect(normalizeCollectionStatus(input)).toBe('owned');
    }
  });

  it('passes every known token through unchanged', () => {
    for (const status of COLLECTION_STATUSES) {
      expect(normalizeCollectionStatus(status)).toBe(status);
    }
  });

  it('tolerates case and padding, as a hand-written request body will have', () => {
    expect(normalizeCollectionStatus('  WANTED ')).toBe('wanted');
    expect(normalizeCollectionStatus('For Sale')).toBe('for-sale');
  });

  it('refuses an unknown word rather than storing it', () => {
    expect(normalizeCollectionStatus('wishlist')).toBe('owned');
    expect(normalizeCollectionStatus('DROP TABLE Coins')).toBe('owned');
  });
});

describe('the server copy has not drifted from the Angular one', () => {
  // src/app/types/collection-status.ts, two levels up from server/db.
  const clientSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'app', 'types', 'collection-status.ts'),
    'utf8'
  );

  /** The tokens inside the client's `COLLECTION_STATUSES = [...] as const`. */
  function clientStatuses(): string[] {
    const block = clientSource.match(/COLLECTION_STATUSES\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1];
    expect(block, 'could not find COLLECTION_STATUSES in the Angular module').toBeTruthy();
    return [...(block as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  it('found the Angular list to compare against', () => {
    // Guards the parser, so the drift test below can't pass vacuously.
    expect(clientStatuses().length).toBeGreaterThan(1);
  });

  it('lists the same tokens in the same order', () => {
    expect([...COLLECTION_STATUSES]).toEqual(clientStatuses());
  });

  it('agrees with the Angular module about the default', () => {
    const clientDefault = clientSource.match(
      /DEFAULT_COLLECTION_STATUS\s*:\s*CollectionStatus\s*=\s*'([^']+)'/
    )?.[1];

    expect(clientDefault).toBe(DEFAULT_COLLECTION_STATUS);
  });
});
