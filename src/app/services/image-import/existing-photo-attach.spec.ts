 /*
 * existing-photo-attach.spec.ts
 *
 * runAttach, for coins that ALREADY have photos.
 *
 * THE BUG: adding a few coin images to a folder that has already been
 * imported makes the program try to import every image in it again, even
 * though most of the coins already have images attached.
 *
 * Two separate defences are tested here, and they are independent:
 *
 *   1. THE MODE. What the user chose should happen to coins that already have
 *      photos — leave them alone (the default), replace what they have, or
 *      keep both. See existing-photo-mode.ts.
 *   2. THE SKIP. Even under "keep both", a file that is already on the coin is
 *      not attached again. Compared by the ORIGINAL file's path, which is the
 *      only thing that identifies a source file. See already-attached.ts.
 *
 * Without (2), re-importing a folder where 290 of 300 photos were already
 * attached would attach all 300 again — the mode alone does not fix the bug.
  */

import { describe, expect, it, vi } from 'vitest';
import { runAttach } from './attach-runner';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';

const BASE = 'D:\\Coin Pictures';

function makeCoin(id: string, imagePaths: string[] = []): CoinRecord {
  return {
    id, denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 120, notes: '',
    imagePaths, source: 'manual'
  };
}

function makeRow(fileName: string, coinId: string): BatchImageRow {
  return {
    fileName,
    thumbnailUrl: '',
    result: { status: 'auto', matchedRecordId: coinId, confidence: 1, reason: '', parsed: {} } as never,
    selectedCoinId: coinId,
    selectionReason: '',
    confidence: 1,
    decision: 'auto',
    selected: true,
    photo: { side: 'obverse', takeNumber: null } as never,
    sizeBytes: 1000
  } as BatchImageRow;
}

function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

const stubEncode = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

/** Two coins: one that already has a photo, one that has none. */
function twoCoinSetup() {
  const files = new Map<string, File>([
    ['has.jpg', pickedFile('has.jpg', 'has.jpg')],
    ['empty.jpg', pickedFile('empty.jpg', 'empty.jpg')]
  ]);
  const inventory = [
    makeCoin('has-photos', ['data:image/jpeg;base64,OLD-1', 'data:image/jpeg;base64,OLD-2']),
    makeCoin('no-photos')
  ];
  const rows = [makeRow('has.jpg', 'has-photos'), makeRow('empty.jpg', 'no-photos')];
  return { files, inventory, rows };
}

// ===========================================================================
// 1. THE MODE
// ===========================================================================

describe('runAttach — existingPhotoMode "leave" (the default)', () => {
  it('writes nothing at all to a coin that already has photos', async () => {
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'leave'
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe('no-photos');
  });

  it('is what you get when no mode is passed at all', async () => {
    // The default has to live in the runner too, not only in the UI: a caller
    // that forgets the option must not fall back to the duplicating
    // behaviour this feature exists to remove.
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, { files, inventory, baseFolder: BASE, attach, encode: stubEncode });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe('no-photos');
  });

  it('does not even READ the file for a coin it is leaving alone', async () => {
    // The whole value of the default is that it is cheap: no 46 MB read off
    // the share, no canvas decode, for a coin we are not going to touch.
    const { files, inventory, rows } = twoCoinSetup();
    const encode = vi.fn(stubEncode);

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach: vi.fn(), encode,
      existingPhotoMode: 'leave'
    });

    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][0].name).toBe('empty.jpg');
  });

  it('reports the untouched rows as skipped, not attached', async () => {
    const { files, inventory, rows } = twoCoinSetup();

    const summary = await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach: vi.fn(), encode: stubEncode,
      existingPhotoMode: 'leave'
    });

    expect(summary.attached).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.coinsTouched).toBe(1);
  });
});

describe('runAttach — existingPhotoMode "replace"', () => {
  it('writes ONLY the new photos, dropping the coin s current ones', async () => {
    // PUT /api/coins/:id deletes and re-inserts the whole image set, so an
    // imagePaths array without the old entries IS the delete.
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'replace'
    });

    const call = attach.mock.calls.find(c => c[0] === 'has-photos')!;
    expect(call[1]).toEqual(['data:image/jpeg;base64,SHRUNK-has.jpg']);
    expect(call[1]).not.toContain('data:image/jpeg;base64,OLD-1');
  });

  it('still attaches everything for a coin with no photos', async () => {
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'replace'
    });

    const call = attach.mock.calls.find(c => c[0] === 'no-photos')!;
    expect(call[1]).toEqual(['data:image/jpeg;base64,SHRUNK-empty.jpg']);
  });

  it('does NOT skip a file that is already attached', async () => {
    // Under replace the existing rows are being deleted, so "already
    // attached" is about to stop being true. Skipping would leave the coin
    // with NO copy of that photo at all — the one way this feature could
    // destroy something outright.
    const files = new Map([['a.jpg', pickedFile('a.jpg', 'a.jpg')]]);
    const attach = vi.fn();

    await runAttach([makeRow('a.jpg', 'c1')], {
      files,
      inventory: [makeCoin('c1', ['data:image/jpeg;base64,OLD'])],
      baseFolder: BASE,
      attach,
      encode: stubEncode,
      existingPhotoMode: 'replace',
      existingSourcePaths: { c1: ['D:\\Coin Pictures\\a.jpg'] }
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1]).toEqual(['data:image/jpeg;base64,SHRUNK-a.jpg']);
  });
});

describe('runAttach — existingPhotoMode "add"', () => {
  it('keeps the existing photos and puts the new ones after them', async () => {
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add'
    });

    const call = attach.mock.calls.find(c => c[0] === 'has-photos')!;
    expect(call[1]).toEqual([
      'data:image/jpeg;base64,OLD-1',
      'data:image/jpeg;base64,OLD-2',
      'data:image/jpeg;base64,SHRUNK-has.jpg'
    ]);
  });
});

// ===========================================================================
// 2. THE SKIP — files already attached to that coin
// ===========================================================================

describe('runAttach — skipping files already attached to the coin', () => {
  /** Three files; the first two are already on the coin. */
  function reimportSetup() {
    const files = new Map<string, File>([
      ['old-1.jpg', pickedFile('old-1.jpg', 'Halves/old-1.jpg')],
      ['old-2.jpg', pickedFile('old-2.jpg', 'Halves/old-2.jpg')],
      ['brand-new.jpg', pickedFile('brand-new.jpg', 'Halves/brand-new.jpg')]
    ]);
    const rows = [
      makeRow('old-1.jpg', 'c1'),
      makeRow('old-2.jpg', 'c1'),
      makeRow('brand-new.jpg', 'c1')
    ];
    const inventory = [makeCoin('c1', ['data:image/jpeg;base64,OLD-1', 'data:image/jpeg;base64,OLD-2'])];
    return { files, rows, inventory };
  }

  it('attaches only the files that are not already on the coin', async () => {
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: ['D:\\Coin Pictures\\Halves\\old-1.jpg', 'D:\\Coin Pictures\\Halves\\old-2.jpg']
      }
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1]).toEqual([
      'data:image/jpeg;base64,OLD-1',
      'data:image/jpeg;base64,OLD-2',
      'data:image/jpeg;base64,SHRUNK-brand-new.jpg'
    ]);
  });

  it('does not read the files it is going to skip', async () => {
    // This IS the fix for "wanted to try importing all the images again": the
    // expensive part is the read and the canvas decode, and a skipped file
    // must cost neither.
    const { files, rows, inventory } = reimportSetup();
    const encode = vi.fn(stubEncode);

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach: vi.fn(), encode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: ['D:\\Coin Pictures\\Halves\\old-1.jpg', 'D:\\Coin Pictures\\Halves\\old-2.jpg']
      }
    });

    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][0].name).toBe('brand-new.jpg');
  });

  it('matches stored paths whose case and separators differ', async () => {
    // The two sides of this comparison are produced by different code at
    // different times, so neither casing nor separator style can be relied on.
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: ['d:/coin pictures/halves/OLD-1.JPG', 'D:\\Coin Pictures\\\\Halves\\old-2.jpg']
      }
    });

    expect(attach.mock.calls[0][1]).toEqual([
      'data:image/jpeg;base64,OLD-1',
      'data:image/jpeg;base64,OLD-2',
      'data:image/jpeg;base64,SHRUNK-brand-new.jpg'
    ]);
  });

  it('writes nothing when EVERY file is already attached', async () => {
    // The usual situation for most coins on a re-import. An import that
    // re-saves a coin with an identical image list is a pointless round trip
    // and a pointless delete-and-reinsert of its CoinImages rows.
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    const summary = await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: [
          'D:\\Coin Pictures\\Halves\\old-1.jpg',
          'D:\\Coin Pictures\\Halves\\old-2.jpg',
          'D:\\Coin Pictures\\Halves\\brand-new.jpg'
        ]
      }
    });

    expect(attach).not.toHaveBeenCalled();
    expect(summary.attached).toBe(0);
    expect(summary.coinsTouched).toBe(0);
    expect(summary.skipped).toBe(3);
  });

  it('does not skip a path recorded against a DIFFERENT coin', async () => {
    const files = new Map([['a.jpg', pickedFile('a.jpg', 'a.jpg')]]);
    const attach = vi.fn();

    await runAttach([makeRow('a.jpg', 'c1')], {
      files,
      inventory: [makeCoin('c1'), makeCoin('c2')],
      baseFolder: BASE,
      attach,
      encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: { c1: [], c2: ['D:\\Coin Pictures\\a.jpg'] }
    });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][1]).toEqual(['data:image/jpeg;base64,SHRUNK-a.jpg']);
  });

  it('attaches everything when no source paths were supplied at all', async () => {
    // FAILS OPEN. If the bulk lookup could not run, the import behaves exactly
    // as it did before this feature. Skipping photos on no evidence would be
    // data loss dressed up as a convenience.
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add'
    });

    expect(attach.mock.calls[0][1]).toHaveLength(5);
  });

  it('attaches everything when there is no base folder to build a path from', async () => {
    // With no base folder every candidate path is null, so nothing can be
    // identified and nothing may be skipped. Importing without recording
    // paths is a legitimate, long-standing choice.
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, attach, encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: ['D:\\Coin Pictures\\Halves\\old-1.jpg', 'D:\\Coin Pictures\\Halves\\old-2.jpg']
      }
    });

    expect(attach.mock.calls[0][1]).toHaveLength(5);
  });

  it('reports a skipped-because-already-attached file as skipped, not failed', async () => {
    // It is not an error and must never show up in the failures list, which
    // is the thing the user reads to find out what went wrong.
    const { files, rows, inventory } = reimportSetup();

    const summary = await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach: vi.fn(), encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: { c1: ['D:\\Coin Pictures\\Halves\\old-1.jpg'] }
    });

    expect(summary.failures).toEqual([]);
    expect(summary.attached).toBe(2);
    expect(summary.skipped).toBe(1);
  });

  it('counts only the files it will really read in the progress total', async () => {
    // The progress bar's denominator used to be "every ticked row". With most
    // of them skipped it would crawl to 1/300 and then jump to done, which
    // reads as a hang on the exact screen this feature exists to keep
    // responsive.
    const { files, rows, inventory } = reimportSetup();
    const seen: number[] = [];

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach: vi.fn(), encode: stubEncode,
      existingPhotoMode: 'add',
      existingSourcePaths: {
        c1: ['D:\\Coin Pictures\\Halves\\old-1.jpg', 'D:\\Coin Pictures\\Halves\\old-2.jpg']
      },
      onProgress: p => seen.push(p.total)
    });

    expect(new Set(seen)).toEqual(new Set([1]));
  });
});
