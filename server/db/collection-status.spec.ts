/**
 * db/collection-status.spec.ts — the five status tokens, and the guard that
 * stops the server's copy of them drifting away from the client's.
 *
 * WHY THERE ARE TWO COPIES OF THIS LIST AT ALL
 * `server/` is a separate TypeScript project: its tsconfig sets `rootDir: "."`
 * and includes only `**\/*.ts` beneath it, so it cannot import from
 * `src/app/types/`, and making it able to would mean restructuring the build
 * of both halves of the app for one five-element array.
 *
 * So the array is written down twice, which is a drift risk — and this file
 * is the answer to it. The last test below READS the Angular module off disk
 * and fails if the two lists disagree, exactly as db/coin-fields.spec.ts reads
 * setup-database.sql and fails when a parameter length no longer matches its
 * column. A duplicate that cannot silently diverge is a copy; a duplicate that
 * can is a bug waiting to happen.
 *
 * WHAT GOES WRONG IF THE NORMALISER IS WRONG
 * Coins.CollectionStatus is NVARCHAR(20) NOT NULL DEFAULT 'owned'. Two
 * failures are possible and both are bad:
 *
 *   - binding NULL to it aborts the INSERT with a constraint violation, so
 *     the user cannot save a coin at all; and
 *   - binding arbitrary text puts a sixth value into a five-value column,
 *     which nothing downstream has a rule for.
 *
 * The normaliser prevents both by answering 'owned' for everything it does
 * not recognise.
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
    // A token longer than the bound parameter would be silently truncated by
    // the mssql driver before SQL Server ever saw it — the exact class of bug
    // db/coin-fields.ts exists to prevent.
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
    // Guards the parser itself. If the client module is reformatted so this
    // regex stops matching, the drift test below would pass vacuously — which
    // is worse than no test, because it looks like cover.
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
