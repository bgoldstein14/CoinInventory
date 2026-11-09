/**
 * report-images.spec.ts
 *
 * Photographs are the reason this feature exists — a CSV cannot carry them —
 * and they are also the only way this feature can hurt anybody. The stored
 * copy in `imagePaths` is a ~1600px JPEG at roughly 250 KB of base64; 300
 * coins with two apiece is about 150 MB. Two separate defences are tested
 * here:
 *
 *   1. a PLAN that caps how many photographs are asked for, and
 *   2. a COLLECTOR that loads one coin at a time and keeps only the
 *      thumbnail, so the full-size originals are never all live at once.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../../types/coin.model';
import {
  IMAGES_PER_COIN_CAP,
  REPORT_IMAGE_BUDGET_BYTES,
  THUMBNAIL_MAX_EDGE_PX,
  coinPhotoCount,
  collectReportImages,
  describeReportImages,
  estimateDataUrlBytes,
  makeCoinImageLoader,
  planReportImages
} from './report-images';

function coin(id: string, imagePaths: string[] = []): CoinRecord {
  return {
    id, denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 0, currentValue: 0,
    notes: '', imagePaths, source: 'manual'
  };
}

/** A data URL of a given decoded byte size, near enough for budget arithmetic. */
function fakeImage(bytes: number): string {
  return `data:image/jpeg;base64,${'A'.repeat(Math.ceil(bytes * 4 / 3))}`;
}

describe('the caps themselves', () => {
  it('asks for at most two photographs per coin', () => {
    // Obverse and reverse. That is what a numismatic record is, and it is
    // what an insurer needs to identify the coin. A third angle doubles the
    // page count for no identifying value.
    expect(IMAGES_PER_COIN_CAP).toBe(2);
  });

  it('thumbnails to a size that still prints legibly', () => {
    // Printed at roughly 1.1in on the page, 480px is about 430 dpi — past
    // what any home printer resolves — while costing roughly a tenth of the
    // bytes of the stored 1600px copy.
    expect(THUMBNAIL_MAX_EDGE_PX).toBeGreaterThanOrEqual(320);
    expect(THUMBNAIL_MAX_EDGE_PX).toBeLessThanOrEqual(640);
  });

  it('has a hard ceiling on the whole document', () => {
    expect(REPORT_IMAGE_BUDGET_BYTES).toBeGreaterThan(0);
    expect(REPORT_IMAGE_BUDGET_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe('coinPhotoCount', () => {
  it('counts the in-memory image array when there is one', () => {
    expect(coinPhotoCount(coin('c1', ['a', 'b']))).toBe(2);
  });

  it('falls back to the server imageCount when the payloads were not sent', () => {
    // GET /api/coins?includeImages=false omits `imagePaths` ENTIRELY (the
    // key is absent, not an empty array) and sends `imageCount` instead.
    // Without this branch the report quietly prints no photographs.
    const withoutPayloads = { ...coin('c1'), imageCount: 3 } as unknown as CoinRecord;
    delete (withoutPayloads as unknown as Record<string, unknown>)['imagePaths'];
    expect(coinPhotoCount(withoutPayloads)).toBe(3);
  });

  it('is zero for a coin with no photographs either way', () => {
    expect(coinPhotoCount(coin('c1'))).toBe(0);
  });
});

describe('planReportImages', () => {
  it('asks for nothing from a coin with no photographs', () => {
    const plan = planReportImages([coin('c1'), coin('c2', ['a'])]);
    expect(plan.requests.map(request => request.coinId)).toEqual(['c2']);
    expect(plan.coinsWithoutPhotos).toBe(1);
  });

  it('caps each coin at the per-coin limit and reports what it left behind', () => {
    const plan = planReportImages([coin('c1', ['a', 'b', 'c', 'd'])]);
    expect(plan.requests).toEqual([{ coinId: 'c1', take: IMAGES_PER_COIN_CAP }]);
    expect(plan.photosBeyondPerCoinCap).toBe(2);
  });

  it('plans nothing at all for an empty collection', () => {
    expect(planReportImages([])).toEqual({
      requests: [], coinsWithoutPhotos: 0, photosBeyondPerCoinCap: 0, requestedPhotos: 0
    });
  });

  it('counts how many photographs it intends to embed', () => {
    const plan = planReportImages([coin('c1', ['a', 'b', 'c']), coin('c2', ['a'])]);
    expect(plan.requestedPhotos).toBe(3);
  });
});

describe('estimateDataUrlBytes', () => {
  it('estimates the decoded size of a base64 data URL', () => {
    expect(estimateDataUrlBytes(fakeImage(3000))).toBeGreaterThan(2900);
    expect(estimateDataUrlBytes(fakeImage(3000))).toBeLessThan(3100);
  });

  it('is zero for an empty string rather than NaN', () => {
    expect(estimateDataUrlBytes('')).toBe(0);
  });
});

describe('collectReportImages', () => {
  function deps(overrides: Partial<Parameters<typeof collectReportImages>[1]> = {}) {
    return {
      loadCoinImages: vi.fn(async () => [fakeImage(250_000), fakeImage(250_000)]),
      toThumbnail: vi.fn(async () => fakeImage(20_000)),
      ...overrides
    } as Parameters<typeof collectReportImages>[1];
  }

  it('returns the thumbnails keyed by coin', async () => {
    const plan = planReportImages([coin('c1', ['a', 'b'])]);
    const collected = await collectReportImages(plan, deps());
    expect(collected.images.get('c1')).toHaveLength(2);
    expect(collected.includedPhotos).toBe(2);
  });

  it('keeps ONLY the thumbnail, never the full-size original', async () => {
    // If the originals leaked into the result, a 300-coin report would be
    // the 150 MB string this cap exists to prevent.
    const original = fakeImage(250_000);
    const thumbnail = fakeImage(20_000);
    const plan = planReportImages([coin('c1', ['a'])]);
    const collected = await collectReportImages(plan, deps({
      loadCoinImages: vi.fn(async () => [original]),
      toThumbnail: vi.fn(async () => thumbnail)
    }));
    expect(collected.images.get('c1')).toEqual([thumbnail]);
    expect(collected.bytes).toBeLessThan(estimateDataUrlBytes(original));
  });

  it('loads ONE coin at a time, never the whole collection at once', async () => {
    let live = 0;
    let highWaterMark = 0;
    const plan = planReportImages([coin('c1', ['a']), coin('c2', ['a']), coin('c3', ['a'])]);
    await collectReportImages(plan, deps({
      loadCoinImages: vi.fn(async () => {
        live++;
        highWaterMark = Math.max(highWaterMark, live);
        await Promise.resolve();
        live--;
        return [fakeImage(250_000)];
      })
    }));
    expect(highWaterMark).toBe(1);
  });

  it('never asks a coin for more photographs than the plan allows', async () => {
    const load = vi.fn(async () => [fakeImage(1000), fakeImage(1000), fakeImage(1000), fakeImage(1000)]);
    const plan = planReportImages([coin('c1', ['a', 'b', 'c', 'd'])]);
    const collected = await collectReportImages(plan, deps({ loadCoinImages: load }));
    expect(collected.images.get('c1')).toHaveLength(IMAGES_PER_COIN_CAP);
  });

  it('stops at the byte budget and reports how many it dropped', async () => {
    const plan = planReportImages([coin('c1', ['a']), coin('c2', ['a']), coin('c3', ['a'])]);
    const collected = await collectReportImages(plan, {
      ...deps(),
      budgetBytes: 25_000 // room for one 20 KB thumbnail, not two
    });
    expect(collected.includedPhotos).toBe(1);
    expect(collected.droppedForSize).toBe(2);
  });

  it('skips a coin whose images cannot be loaded instead of failing the report', async () => {
    // A report that refuses to print because one photograph is unreadable is
    // worse than a report with one photograph missing.
    const plan = planReportImages([coin('c1', ['a']), coin('c2', ['a'])]);
    const collected = await collectReportImages(plan, deps({
      loadCoinImages: vi.fn(async (coinId: string) => {
        if (coinId === 'c1') throw new Error('database went away');
        return [fakeImage(1000)];
      })
    }));
    expect(collected.images.has('c1')).toBe(false);
    expect(collected.images.get('c2')).toHaveLength(1);
    expect(collected.failedCoins).toBe(1);
  });

  it('does no work at all for a plan with no requests', async () => {
    const load = vi.fn(async () => [fakeImage(1000)]);
    const collected = await collectReportImages(planReportImages([coin('c1')]), deps({ loadCoinImages: load }));
    expect(load).not.toHaveBeenCalled();
    expect(collected.includedPhotos).toBe(0);
  });
});

describe('makeCoinImageLoader', () => {
  it('uses the payloads already in memory rather than asking the server again', async () => {
    const fetchFromServer = vi.fn(async () => ['fetched']);
    const load = makeCoinImageLoader([coin('c1', ['stored-a', 'stored-b'])], fetchFromServer);
    expect(await load('c1')).toEqual(['stored-a', 'stored-b']);
    expect(fetchFromServer).not.toHaveBeenCalled();
  });

  it('fetches when the list endpoint omitted the payloads', async () => {
    // The list endpoint's default shape: `imagePaths` absent, `imageCount`
    // present.
    const withoutPayloads = { ...coin('c1'), imageCount: 2 } as unknown as CoinRecord;
    delete (withoutPayloads as unknown as Record<string, unknown>)['imagePaths'];

    const fetchFromServer = vi.fn(async () => ['fetched-a', 'fetched-b']);
    const load = makeCoinImageLoader([withoutPayloads], fetchFromServer);
    expect(await load('c1')).toEqual(['fetched-a', 'fetched-b']);
    expect(fetchFromServer).toHaveBeenCalledWith('c1');
  });

  it('fetches for a coin it has never heard of rather than returning nothing', async () => {
    const fetchFromServer = vi.fn(async () => ['fetched']);
    const load = makeCoinImageLoader([], fetchFromServer);
    expect(await load('ghost')).toEqual(['fetched']);
  });
});

describe('describeReportImages', () => {
  it('says how many photographs are on the page', () => {
    const plan = planReportImages([coin('c1', ['a', 'b'])]);
    const note = describeReportImages(plan, {
      images: new Map(), includedPhotos: 2, droppedForSize: 0, failedCoins: 0, bytes: 0
    });
    expect(note).toContain('2 photograph');
  });

  it('owns up to the coins with no photograph on file', () => {
    const plan = planReportImages([coin('c1', ['a']), coin('c2'), coin('c3')]);
    const note = describeReportImages(plan, {
      images: new Map(), includedPhotos: 1, droppedForSize: 0, failedCoins: 0, bytes: 0
    });
    expect(note).toContain('2 coins have no photograph');
  });

  it('owns up to photographs left out for the per-coin cap', () => {
    const plan = planReportImages([coin('c1', ['a', 'b', 'c'])]);
    const note = describeReportImages(plan, {
      images: new Map(), includedPhotos: 2, droppedForSize: 0, failedCoins: 0, bytes: 0
    });
    expect(note).toContain(`first ${IMAGES_PER_COIN_CAP}`);
  });

  it('owns up to photographs dropped to keep the document a sane size', () => {
    const plan = planReportImages([coin('c1', ['a', 'b'])]);
    const note = describeReportImages(plan, {
      images: new Map(), includedPhotos: 1, droppedForSize: 1, failedCoins: 0, bytes: 0
    });
    expect(note).toContain('1 photograph could not be included');
  });

  it('owns up to coins whose photographs failed to load', () => {
    const plan = planReportImages([coin('c1', ['a'])]);
    const note = describeReportImages(plan, {
      images: new Map(), includedPhotos: 0, droppedForSize: 0, failedCoins: 1, bytes: 0
    });
    expect(note).toContain('1 coin');
    expect(note).toMatch(/could not be read|failed/i);
  });
});
