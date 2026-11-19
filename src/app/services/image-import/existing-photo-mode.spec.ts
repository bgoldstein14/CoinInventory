 /*
 * existing-photo-mode.spec.ts
 *
 * The three-way question asked when matched coins already have photos, and
 * its counts. The counts ("Their 94 current photos are deleted first") are
 * what the user relies on before deleting photos, so they must be exact.
  */

import { describe, expect, it } from 'vitest';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import {
  DEFAULT_EXISTING_PHOTO_MODE,
  countExistingPhotos,
  coinIdsWithExistingPhotos,
  replaceConfirmationMessage,
  rowsWrittenUnderMode
} from './existing-photo-mode';

/** A coin with however many photos the test needs. */
function coin(id: string, photoCount: number): CoinRecord {
  return {
    id,
    imagePaths: Array.from({ length: photoCount }, (_, i) => `data:image/jpeg;base64,${id}-${i}`)
  } as unknown as CoinRecord;
}

/** A review row that will be attached to `coinId`. */
function row(fileName: string, coinId: string | null, overrides: Partial<BatchImageRow> = {}): BatchImageRow {
  return {
    fileName,
    selectedCoinId: coinId,
    selected: true,
    decision: 'auto',
    ...overrides
  } as unknown as BatchImageRow;
}

describe('DEFAULT_EXISTING_PHOTO_MODE', () => {
  it('is "leave" — the only option that can neither delete nor duplicate', () => {
    // "replace" can delete photos and "add" can duplicate them.
    expect(DEFAULT_EXISTING_PHOTO_MODE).toBe('leave');
  });
});

describe('countExistingPhotos', () => {
  it('counts the coins, the ones with photos, the ones without, and the photos', () => {
    const inventory = [coin('a', 3), coin('b', 0), coin('c', 2), coin('d', 0)];
    const rows = [
      row('a1.jpg', 'a'), row('a2.jpg', 'a'),
      row('b1.jpg', 'b'),
      row('c1.jpg', 'c'),
      row('d1.jpg', 'd')
    ];

    expect(countExistingPhotos(rows, inventory)).toEqual({
      matchedCoins: 4,
      coinsWithPhotos: 2,
      coinsWithoutPhotos: 2,
      existingPhotos: 5
    });
  });

  it('counts a coin once however many photos are being imported for it', () => {
    // The counts are of coins, not files.
    const inventory = [coin('a', 1)];
    const rows = [row('1.jpg', 'a'), row('2.jpg', 'a'), row('3.jpg', 'a')];

    const counts = countExistingPhotos(rows, inventory);
    expect(counts.matchedCoins).toBe(1);
    expect(counts.coinsWithPhotos).toBe(1);
  });

  it('counts only the photos of the coins this import actually touches', () => {
    // Only photos of coins in this run, not the whole inventory.
    const inventory = [coin('a', 3), coin('untouched', 99)];
    const rows = [row('a1.jpg', 'a')];

    expect(countExistingPhotos(rows, inventory).existingPhotos).toBe(3);
  });

  it('ignores rows that will not be written', () => {
    // Unticked, skipped and unresolved rows are not part of this import.
    const inventory = [coin('a', 2), coin('b', 2), coin('c', 2)];
    const rows = [
      row('a1.jpg', 'a'),
      row('b1.jpg', 'b', { selected: false }),
      row('c1.jpg', 'c', { decision: 'skipped' }),
      row('none.jpg', null)
    ];

    const counts = countExistingPhotos(rows, inventory);
    expect(counts.matchedCoins).toBe(1);
    expect(counts.existingPhotos).toBe(2);
  });

  it('treats a coin that is not in the inventory as having no photos', () => {
    const counts = countExistingPhotos([row('a1.jpg', 'ghost')], []);
    expect(counts).toEqual({
      matchedCoins: 1,
      coinsWithPhotos: 0,
      coinsWithoutPhotos: 1,
      existingPhotos: 0
    });
  });

  it('is all zeroes for an empty run', () => {
    expect(countExistingPhotos([], [])).toEqual({
      matchedCoins: 0,
      coinsWithPhotos: 0,
      coinsWithoutPhotos: 0,
      existingPhotos: 0
    });
  });
});

describe('coinIdsWithExistingPhotos', () => {
  it('lists each affected coin once', () => {
    const inventory = [coin('a', 1), coin('b', 0), coin('c', 4)];
    const rows = [row('1.jpg', 'a'), row('2.jpg', 'a'), row('3.jpg', 'b'), row('4.jpg', 'c')];

    expect(coinIdsWithExistingPhotos(rows, inventory).sort()).toEqual(['a', 'c']);
  });
});

describe('rowsWrittenUnderMode', () => {
  const inventory = [coin('has', 2), coin('empty', 0)];
  const rows = [row('has.jpg', 'has'), row('empty.jpg', 'empty')];

  it('drops rows for coins that already have photos under "leave"', () => {
    // The default: import only for coins with no photos yet.
    expect(rowsWrittenUnderMode(rows, inventory, 'leave').map(r => r.fileName))
      .toEqual(['empty.jpg']);
  });

  it('keeps every row under "replace"', () => {
    expect(rowsWrittenUnderMode(rows, inventory, 'replace').map(r => r.fileName))
      .toEqual(['has.jpg', 'empty.jpg']);
  });

  it('keeps every row under "add"', () => {
    expect(rowsWrittenUnderMode(rows, inventory, 'add').map(r => r.fileName))
      .toEqual(['has.jpg', 'empty.jpg']);
  });

  it('still excludes unticked and skipped rows under every mode', () => {
    const mixed = [
      row('ok.jpg', 'empty'),
      row('unticked.jpg', 'empty', { selected: false }),
      row('skipped.jpg', 'empty', { decision: 'skipped' })
    ];

    for (const mode of ['leave', 'replace', 'add'] as const) {
      expect(rowsWrittenUnderMode(mixed, inventory, mode).map(r => r.fileName))
        .toEqual(['ok.jpg']);
    }
  });
});

describe('replaceConfirmationMessage', () => {
  const counts = { matchedCoins: 112, coinsWithPhotos: 38, coinsWithoutPhotos: 74, existingPhotos: 94 };

  it('names the exact number of photos about to be deleted', () => {
    const message = replaceConfirmationMessage(counts);
    expect(message).toContain('94');
    expect(message).toContain('38');
  });

  it('says deleted, in those words', () => {
    expect(replaceConfirmationMessage(counts).toLowerCase()).toContain('delete');
  });

  it('says the deletion cannot be undone', () => {
    expect(replaceConfirmationMessage(counts).toLowerCase()).toContain('cannot be undone');
  });

  it('reads correctly in the singular', () => {
    const one = { matchedCoins: 5, coinsWithPhotos: 1, coinsWithoutPhotos: 4, existingPhotos: 1 };
    const message = replaceConfirmationMessage(one);
    expect(message).toContain('1 photo ');
    expect(message).not.toContain('1 photos');
    expect(message).not.toContain('1 coins');
  });
});
