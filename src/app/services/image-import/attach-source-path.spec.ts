/**
 * Tests for the other end of the feature: an image imported from a folder must
 * carry the absolute path of its original file all the way into the request
 * body — without disturbing the append-and-dedupe behaviour of the import, and
 * without breaking the rule that an edit sends ONLY the fields that changed.
 */
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAttach } from './attach-runner';
import { imageSourcePaths } from '../image-source-paths';
import { AttachedImage } from '../../types/coin-image.model';
import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

const BASE = '\\\\192.168.0.10\\Coin Pictures';

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 120, notes: '',
    imagePaths: [], tags: [], source: 'manual',
    ...overrides
  };
}

/** A ticked review row pointing at `coin-1`. */
function makeRow(fileName: string): BatchImageRow {
  return {
    fileName,
    thumbnailUrl: '',
    result: { status: 'auto', matchedRecordId: 'coin-1', confidence: 1, reason: '', parsed: {} } as never,
    selectedCoinId: 'coin-1',
    selectionReason: '',
    confidence: 1,
    decision: 'auto',
    selected: true,
    photo: { side: 'obverse', takeNumber: null } as never,
    sizeBytes: 1000
  } as BatchImageRow;
}

/** A File as a directory picker produces it, with webkitRelativePath set. */
function pickedFile(name: string, relativePath: string): File {
  const file = new File(['x'], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/** There is no <canvas> in Node, so encoding is stubbed. */
const stubEncode = (file: File) => Promise.resolve({
  dataUrl: `data:image/jpeg;base64,SHRUNK-${file.name}`,
  originalBytes: file.size,
  storedBytes: 500
});

describe('runAttach — recording where the original file lives', () => {
  it('pairs each new image with the absolute path of its original', async () => {
    const files = new Map<string, File>([
      ['obverse.jpg', pickedFile('obverse.jpg', 'Business Strikes/obverse.jpg')],
      ['reverse.jpg', pickedFile('reverse.jpg', 'Business Strikes/reverse.jpg')]
    ]);
    const attach = vi.fn();

    await runAttach([makeRow('obverse.jpg'), makeRow('reverse.jpg')], {
      files,
      inventory: [makeCoin()],
      baseFolder: BASE,
      attach,
      encode: stubEncode
    });

    const newImages = attach.mock.calls[0][2] as AttachedImage[];
    expect(newImages).toEqual([
      {
        imageData: 'data:image/jpeg;base64,SHRUNK-obverse.jpg',
        sourcePath: '\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\obverse.jpg'
      },
      {
        imageData: 'data:image/jpeg;base64,SHRUNK-reverse.jpg',
        sourcePath: '\\\\192.168.0.10\\Coin Pictures\\Business Strikes\\reverse.jpg'
      }
    ]);
  });

  it('still appends and de-duplicates the displayed imagePaths', async () => {
    // The second argument is unchanged by this feature: plain data URLs, the
    // coin's existing photos first, and no duplicates.
    const existing = makeCoin({ imagePaths: ['data:image/jpeg;base64,ALREADY-HERE'] });
    const files = new Map([['obverse.jpg', pickedFile('obverse.jpg', 'obverse.jpg')]]);
    const attach = vi.fn();

    await runAttach([makeRow('obverse.jpg')], {
      files, inventory: [existing], baseFolder: BASE, attach, encode: stubEncode
    });

    const imagePaths = attach.mock.calls[0][1] as string[];
    expect(imagePaths).toEqual([
      'data:image/jpeg;base64,ALREADY-HERE',
      'data:image/jpeg;base64,SHRUNK-obverse.jpg'
    ]);
  });

  it('records a null path when no base folder was given', async () => {
    // Importing without a base folder still works — it just cannot document
    // where anything came from, which is how the import behaved before.
    const files = new Map([['a.jpg', pickedFile('a.jpg', 'a.jpg')]]);
    const attach = vi.fn();

    await runAttach([makeRow('a.jpg')], {
      files, inventory: [makeCoin()], attach, encode: stubEncode
    });

    const newImages = attach.mock.calls[0][2] as AttachedImage[];
    expect(newImages[0].sourcePath).toBe(null);
  });
});

describe('the attached path reaches the server', () => {
  beforeEach(() => {
    imageSourcePaths.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    imageSourcePaths.clear();
  });

  it('sends imagePaths as { imageData, sourcePath } once a path is known', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    const coin = makeCoin({ imagePaths: [] });
    // Set directly so the coin counts as already existing on the server (not a
    // draft), which is what puts the edit on the minimal-PUT route.
    inv.inventory.set([coin]);

    const imageData = 'data:image/jpeg;base64,SHRUNK';
    const sourcePath = '\\\\192.168.0.10\\Coin Pictures\\Proofs\\a.jpg';

    // This is exactly what BatchImportSession does on confirm.
    imageSourcePaths.recordAll([{ imageData, sourcePath }]);
    inv.updateCoin(coin.id, { imagePaths: [imageData] });

    // The write is debounced by one second.
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockApiService.updateCoin).toHaveBeenCalledTimes(1);
    const [sentId, body] = (mockApiService.updateCoin as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, Record<string, unknown>];

    expect(sentId).toBe(coin.id);
    expect(body['imagePaths']).toEqual([{ imageData, sourcePath }]);

    // THE PARTIAL-UPDATE GUARANTEE: only the field that changed is sent. A
    // previous refactor sent whole records and blanked out untouched columns.
    expect(Object.keys(body)).toEqual(['imagePaths']);
  });

  it('keeps the plain-string form when no path is known', async () => {
    // The backend has always accepted a bare base64 string, and that stays the
    // normal case — the object form only appears when it carries information.
    const { inv, mockApiService } = createTestInventoryService();
    const coin = makeCoin();
    inv.inventory.set([coin]);

    inv.updateCoin(coin.id, { imagePaths: ['data:image/jpeg;base64,NO-PATH'] });
    await vi.advanceTimersByTimeAsync(1100);

    const body = (mockApiService.updateCoin as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as Record<string, unknown>;
    expect(body['imagePaths']).toEqual(['data:image/jpeg;base64,NO-PATH']);
  });

  it('does not wipe the paths of images it is not changing', async () => {
    // PUT /api/coins/:id REPLACES the whole image set, so deleting or
    // re-ordering ONE photo re-sends all of them. Without the registry the
    // others would go back as bare strings and lose their recorded paths.
    const { inv, mockApiService } = createTestInventoryService();
    const keep = 'data:image/jpeg;base64,KEEP';
    const drop = 'data:image/jpeg;base64,DROP';
    inv.inventory.set([makeCoin({ imagePaths: [keep, drop] })]);

    imageSourcePaths.recordAll([
      { imageData: keep, sourcePath: 'C:\\Pics\\keep.jpg' },
      { imageData: drop, sourcePath: 'C:\\Pics\\drop.jpg' }
    ]);

    // The user deletes the second photo in the gallery.
    inv.updateCoin('coin-1', { imagePaths: [keep] });
    await vi.advanceTimersByTimeAsync(1100);

    const body = (mockApiService.updateCoin as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as Record<string, unknown>;
    expect(body['imagePaths']).toEqual([
      { imageData: keep, sourcePath: 'C:\\Pics\\keep.jpg' }
    ]);
  });

  it('leaves other fields as plain values', async () => {
    // Only `imagePaths` is ever rewritten; an ordinary edit is untouched.
    const { inv, mockApiService } = createTestInventoryService();
    inv.inventory.set([makeCoin()]);

    inv.updateCoin('coin-1', { grade: 'MS65' });
    await vi.advanceTimersByTimeAsync(1100);

    const body = (mockApiService.updateCoin as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({ grade: 'MS65' });
  });
});
