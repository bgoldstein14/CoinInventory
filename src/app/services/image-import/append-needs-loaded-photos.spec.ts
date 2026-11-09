 /*
 * append-needs-loaded-photos.spec.ts
 *
 * THE WORST BUG THIS CHANGE COULD HAVE INTRODUCED, pinned.
 *
 * The batch photo import's "Keep both" mode appends: it builds
 *
 *     [...the coin's existing photographs, ...the new ones]
 *
 * and hands that COMPLETE array to `PUT /api/coins/:id`, which deletes every
 * CoinImages row for the coin and re-inserts exactly what it was given.
 *
 * That code used to read the existing half as `coin?.imagePaths ?? []`. It
 * was correct only because `GET /api/coins` inlined every photograph, so the
 * array was always there. Now it is ABSENT by default — and `?? []` turns an
 * absent array into an empty one, which means "Keep both" would have sent
 * ONLY the new photographs and silently deleted every photograph already on
 * the coin -- on a real collection, with a 200 response and nothing in any
 * log.
 *
 * THE RULE
 *
 * APPEND IS ONLY SAFE WHEN WE KNOW WHAT WE ARE APPENDING TO. So, per coin:
 *
 *   - photographs already in memory  -> use them
 *   - `imageCount` says zero         -> [] is a fact, not a guess. Safe.
 *   - otherwise                      -> fetch them. If the fetch fails,
 *                                       SKIP THE COIN. Do not write.
 *
 * Skipping costs the user a re-run of an import. Guessing costs photographs
 * that no longer exist anywhere.
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

    // THE ASSERTION THIS FILE EXISTS FOR. Not "attach was called with the old
    // photos" — attach was NOT CALLED. A PUT that cannot be built correctly
    // must not be built at all.
    expect(attach).not.toHaveBeenCalled();
    // And the user is told, rather than being left to discover it.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.fileName).toBe('new.jpg');
    expect(result.coinsTouched).toBe(0);
  });

  it('WRITES NOTHING when no loader was supplied at all', async () => {
    // A caller that forgets to wire the loader must fail safe, not fall back
    // to the behaviour that deletes photographs.
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
    // 'replace' MEANS "delete what is there", so there is nothing to read
    // first — and reading it would be a few megabytes spent to throw away.
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
