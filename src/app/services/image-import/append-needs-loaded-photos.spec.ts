 /*
 * "Keep both" sends [...existing, ...new] to PUT /api/coins/:id, which
 * replaces the coin's whole image set. Coins from the list endpoint carry
 * `imageCount` but no `imagePaths`, so treating a missing array as empty
 * would delete every existing photo. Per coin:
 *
 *   - photographs already in memory  -> use them
 *   - `imageCount` is zero           -> [] is known to be correct
 *   - otherwise                      -> fetch them; if that fails, skip the
 *                                       coin and write nothing
  */

import { describe, expect, it, vi } from 'vitest';
import { runAttach } from './attach-runner';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';

/** A coin whose photographs ARE loaded. */
function loadedCoin(id: string, imagePaths: string[]): CoinRecord {
  return {
    id, denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 120, notes: '',
    imagePaths, source: 'manual'
  };
}

/** A coin straight off the list endpoint: an imageCount and no imagePaths. */
function listLoadedCoin(id: string, imageCount: number): CoinRecord {
  const coin = { ...loadedCoin(id, []), imageCount } as unknown as Record<string, unknown>;
  delete coin['imagePaths'];
  return coin as unknown as CoinRecord;
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

function pickedFile(name: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: name });
  return file;
}

const stubEncode = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,NEW-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

function baseOptions(inventory: CoinRecord[], attach: ReturnType<typeof vi.fn>) {
  return {
    files: new Map<string, File>([['new.jpg', pickedFile('new.jpg')]]),
    inventory,
    existingPhotoMode: 'add' as const,
    attach,
    encode: stubEncode
  };
}

describe('"Keep both" when the coin\'s photographs are not in memory', () => {
  it('fetches them and appends to the REAL set', async () => {
    const attach = vi.fn();
    const loadExistingImages = vi.fn(async () => ['data:image/jpeg;base64,OLD-1', 'data:image/jpeg;base64,OLD-2']);

    await runAttach([makeRow('new.jpg', 'c1')], {
      ...baseOptions([listLoadedCoin('c1', 2)], attach),
      loadExistingImages
    });

    expect(loadExistingImages).toHaveBeenCalledWith('c1');
    expect(attach).toHaveBeenCalledTimes(1);
    const [, imagePaths] = attach.mock.calls[0]!;
    expect(imagePaths).toEqual([
      'data:image/jpeg;base64,OLD-1',
      'data:image/jpeg;base64,OLD-2',
      'data:image/jpeg;base64,NEW-new.jpg'
    ]);
  });

  it('WRITES NOTHING when the photographs cannot be fetched', async () => {
    const attach = vi.fn();
    const loadExistingImages = vi.fn(async () => { throw new Error('offline'); });

    const result = await runAttach([makeRow('new.jpg', 'c1')], {
      ...baseOptions([listLoadedCoin('c1', 4)], attach),
      loadExistingImages
    });

    expect(attach).not.toHaveBeenCalled();
    // Reported to the user as a failure.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.fileName).toBe('new.jpg');
    expect(result.coinsTouched).toBe(0);
  });

  it('WRITES NOTHING when no loader was supplied at all', async () => {
    const attach = vi.fn();

    const result = await runAttach([makeRow('new.jpg', 'c1')], baseOptions([listLoadedCoin('c1', 4)], attach));

    expect(attach).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
  });

  it('needs no fetch when the server already said the coin has none', async () => {
    const attach = vi.fn();
    const loadExistingImages = vi.fn(async () => []);

    await runAttach([makeRow('new.jpg', 'c1')], {
      ...baseOptions([listLoadedCoin('c1', 0)], attach),
      loadExistingImages
    });

    expect(loadExistingImages).not.toHaveBeenCalled();
    const [, imagePaths] = attach.mock.calls[0]!;
    expect(imagePaths).toEqual(['data:image/jpeg;base64,NEW-new.jpg']);
  });

  it('needs no fetch when the photographs are already in memory', async () => {
    const attach = vi.fn();
    const loadExistingImages = vi.fn(async () => ['SHOULD-NOT-BE-USED']);

    await runAttach([makeRow('new.jpg', 'c1')], {
      ...baseOptions([loadedCoin('c1', ['data:image/jpeg;base64,OLD'])], attach),
      loadExistingImages
    });

    expect(loadExistingImages).not.toHaveBeenCalled();
    const [, imagePaths] = attach.mock.calls[0]!;
    expect(imagePaths).toEqual(['data:image/jpeg;base64,OLD', 'data:image/jpeg;base64,NEW-new.jpg']);
  });

  it('still empties the coin under "replace", without a pointless fetch', async () => {
    // 'replace' discards the existing photos, so there is nothing to fetch.
    const attach = vi.fn();
    const loadExistingImages = vi.fn(async () => ['SHOULD-NOT-BE-USED']);

    await runAttach([makeRow('new.jpg', 'c1')], {
      ...baseOptions([listLoadedCoin('c1', 5)], attach),
      existingPhotoMode: 'replace' as const,
      loadExistingImages
    });

    expect(loadExistingImages).not.toHaveBeenCalled();
    const [, imagePaths] = attach.mock.calls[0]!;
    expect(imagePaths).toEqual(['data:image/jpeg;base64,NEW-new.jpg']);
  });
});
