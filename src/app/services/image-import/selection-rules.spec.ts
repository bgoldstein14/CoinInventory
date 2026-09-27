import { describe, expect, it } from 'vitest';
import { BatchImageRow } from '../../types/coin.model';
import { describePhoto } from './photo-variant';
import {
  applyBulkAction,
  deselectLabels,
  deselectRetakes,
  keepOnlyObverseReverse,
  setAllSelected,
  toggleRow
} from './selection-rules';

/**
 * Build a row the way the batch importer would, so the tests exercise the real
 * side/variant/take detection rather than hand-written flags.
 */
function row(fileName: string, coinId: string | null = 'coin-1'): BatchImageRow {
  return {
    fileName,
    thumbnailUrl: '',
    result: {
      imagePath: fileName,
      matchedRecordId: coinId,
      confidence: 0.9,
      reason: 'test',
      status: coinId ? 'auto' : 'none',
      candidates: [],
      parsed: {
        fileName, year: null, mintMark: null, denomination: null,
        denominationLabel: null, coinTypeTokens: [], grade: null,
        certNumbers: [], certCompanies: [], tokens: [], isEmpty: true
      },
      runnerUpGap: 0
    },
    selectedCoinId: coinId,
    selectionReason: 'test',
    confidence: 0.9,
    decision: coinId ? 'auto' : 'review',
    selected: !!coinId,
    photo: describePhoto(fileName),
    sizeBytes: 2_500_000
  };
}

/** A realistic 8-shot coin, exactly the shape the share produces. */
function eightShotCoin(): BatchImageRow[] {
  return [
    row('1880-S $1 - MS64 - Obverse - Photo.jpg'),
    row('1880-S $1 - MS64 - Reverse - Photo.jpg'),
    row('1880-S $1 - MS64 - Obverse - Small.jpg'),
    row('1880-S $1 - MS64 - Reverse - Small.jpg'),
    row('1880-S $1 - MS64 - Obverse - Orig.jpg'),
    row('1880-S $1 - MS64 - Reverse - Sharpened.jpg'),
    row('1880-S $1 - MS64 - Label.jpg'),
    row('1880-S $1 - MS64-2.jpg')
  ];
}

const selectedNames = (rows: readonly BatchImageRow[]) =>
  rows.filter(r => r.selected).map(r => r.fileName);

describe('selection defaults', () => {
  it('starts every matched image selected', () => {
    const rows = eightShotCoin();
    expect(rows.every(r => r.selected)).toBe(true);
  });

  it('never starts an unmatched image selected', () => {
    expect(row('Gold Coins.JPG', null).selected).toBe(false);
  });
});

describe('keepOnlyObverseReverse', () => {
  it('keeps both faces and drops labels, retakes and unreadable names', () => {
    const rows = keepOnlyObverseReverse(eightShotCoin());

    expect(selectedNames(rows)).toEqual([
      '1880-S $1 - MS64 - Obverse - Photo.jpg',
      '1880-S $1 - MS64 - Reverse - Photo.jpg',
      '1880-S $1 - MS64 - Obverse - Small.jpg',
      '1880-S $1 - MS64 - Reverse - Small.jpg',
      '1880-S $1 - MS64 - Obverse - Orig.jpg',
      '1880-S $1 - MS64 - Reverse - Sharpened.jpg'
    ]);
    // The label shot and the unlabelled retake are out.
    expect(selectedNames(rows)).not.toContain('1880-S $1 - MS64 - Label.jpg');
    expect(selectedNames(rows)).not.toContain('1880-S $1 - MS64-2.jpg');
  });

  it('combines with deselectRetakes to leave exactly one shot per face', () => {
    const rows = deselectRetakes(keepOnlyObverseReverse(eightShotCoin()));

    expect(selectedNames(rows)).toEqual([
      '1880-S $1 - MS64 - Obverse - Photo.jpg',
      '1880-S $1 - MS64 - Reverse - Photo.jpg'
    ]);
  });

  it('never selects a row that has no coin behind it', () => {
    const rows = keepOnlyObverseReverse([row('Unknown - Obverse.jpg', null)]);
    expect(rows[0].selected).toBe(false);
  });
});

describe('deselectRetakes', () => {
  it('drops take 2+ and the Small / Orig / Sharpened derivatives', () => {
    const rows = deselectRetakes(eightShotCoin());

    expect(selectedNames(rows)).toEqual([
      '1880-S $1 - MS64 - Obverse - Photo.jpg',
      '1880-S $1 - MS64 - Reverse - Photo.jpg',
      '1880-S $1 - MS64 - Label.jpg'
    ]);
  });

  it('is subtractive: it never re-selects something already unticked', () => {
    const rows = deselectRetakes(setAllSelected(eightShotCoin(), false));
    expect(selectedNames(rows)).toEqual([]);
  });
});

describe('deselectLabels', () => {
  it('drops only the slab label shots', () => {
    const rows = deselectLabels(eightShotCoin());

    expect(selectedNames(rows)).toHaveLength(7);
    expect(selectedNames(rows)).not.toContain('1880-S $1 - MS64 - Label.jpg');
  });
});

describe('toggleRow', () => {
  it('unticks a single photo and leaves the rest alone', () => {
    const rows = toggleRow(eightShotCoin(), '1880-S $1 - MS64 - Obverse - Small.jpg');

    expect(selectedNames(rows)).toHaveLength(7);
    expect(selectedNames(rows)).not.toContain('1880-S $1 - MS64 - Obverse - Small.jpg');
  });

  it('ticks it back on', () => {
    const once = toggleRow(eightShotCoin(), '1880-S $1 - MS64 - Label.jpg');
    const twice = toggleRow(once, '1880-S $1 - MS64 - Label.jpg');
    expect(twice.every(r => r.selected)).toBe(true);
  });

  it('refuses to tick a row with no coin assigned', () => {
    const rows = toggleRow([row('Gold Coins.JPG', null)], 'Gold Coins.JPG', true);
    expect(rows[0].selected).toBe(false);
  });

  it('returns a new array and new row objects, for signal change detection', () => {
    const before = eightShotCoin();
    const after = toggleRow(before, before[0].fileName);
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
  });
});

describe('applyBulkAction', () => {
  it('limits the rule to one coin when a coin id is given', () => {
    const rows = [
      ...eightShotCoin(),
      { ...row('1904 $20 - PCGS MS63 - Label.jpg'), selectedCoinId: 'coin-2' }
    ];

    const updated = applyBulkAction(rows, 'deselect-labels', 'coin-1');

    // coin-1's label shot is off...
    expect(updated.find(r => r.fileName === '1880-S $1 - MS64 - Label.jpg')!.selected).toBe(false);
    // ...and coin-2's is untouched.
    expect(updated.find(r => r.fileName === '1904 $20 - PCGS MS63 - Label.jpg')!.selected).toBe(true);
  });

  it('applies to the whole batch when no coin id is given', () => {
    const rows = applyBulkAction(eightShotCoin(), 'deselect-all');
    expect(selectedNames(rows)).toEqual([]);
  });

  it('preserves row order', () => {
    const before = eightShotCoin();
    const after = applyBulkAction(before, 'select-all');
    expect(after.map(r => r.fileName)).toEqual(before.map(r => r.fileName));
  });

  it('supports every advertised action', () => {
    const base = eightShotCoin();
    expect(selectedNames(applyBulkAction(base, 'select-all'))).toHaveLength(8);
    expect(selectedNames(applyBulkAction(base, 'deselect-all'))).toHaveLength(0);
    expect(selectedNames(applyBulkAction(base, 'keep-obverse-reverse'))).toHaveLength(6);
    expect(selectedNames(applyBulkAction(base, 'deselect-retakes'))).toHaveLength(3);
    expect(selectedNames(applyBulkAction(base, 'deselect-labels'))).toHaveLength(7);
  });
});
