 /*
 * existing-photo-attach.spec.ts
 *
 * runAttach for coins that already have photos:
 *
 *   1. The mode: leave them alone (default), replace, or keep both.
 *      See existing-photo-mode.ts.
 *   2. The skip: under "keep both", a file already on the coin (by source
 *      path) is not attached again. See already-attached.ts.
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
    // The default lives in the runner too, not only in the UI.
    const { files, inventory, rows } = twoCoinSetup();
    const attach = vi.fn();

    await runAttach(rows, { files, inventory, baseFolder: BASE, attach, encode: stubEncode });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe('no-photos');
  });

  it('does not even READ the file for a coin it is leaving alone', async () => {
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
    // PUT replaces the whole image set, so omitting the old entries deletes them.
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
    // Under replace the existing rows are deleted, so skipping would leave
    // the coin without that photo.
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
    // A skipped file costs no read or decode.
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
    // Fails open when the source-path lookup didn't run.
    const { files, rows, inventory } = reimportSetup();
    const attach = vi.fn();

    await runAttach(rows, {
      files, inventory, baseFolder: BASE, attach, encode: stubEncode,
      existingPhotoMode: 'add'
    });

    expect(attach.mock.calls[0][1]).toHaveLength(5);
  });

  it('attaches everything when there is no base folder to build a path from', async () => {
    // No base folder means null candidate paths, so nothing can be skipped.
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
    // Skipped files are excluded from the progress total.
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
