/**
 * A newly added photo must not leave a broken grid thumbnail. Attaching a photo
 * paints it at once but PUTs it a second later, so the first thumbnail request
 * 404s, and browsers never retry an unchanged URL. Tested:
 *   1. the revision registry only moves when the server confirms an image write;
 *   2. CoinEditor bumps it only from the success handler of a create/update
 *      carrying `imagePaths`;
 *   3. ApiService gives a different URL for a non-zero revision and the bare URL
 *      for revision 0 (so unchanged coins still revalidate with a 304).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { ApiService } from '../api.service';
import { createTestInventoryService, createMockDependencies } from '../../testing/test-helpers';
import {
  CoinThumbnailRevisionRegistry,
  coinThumbnailRevisions,
  writeTouchesImages
} from './coin-thumbnail-revision';

const PHOTO = 'data:image/jpeg;base64,AAA';
const SECOND_PHOTO = 'data:image/jpeg;base64,BBB';

/**
 * The real ApiService with a stub HttpClient (`coinThumbnailUrl` makes no
 * request), constructed as in api.service.spec.ts to avoid the XHR backend.
 */
function realApiService(): ApiService {
  const http = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return new (ApiService as unknown as new (http: unknown) => ApiService)(http);
}

describe('CoinThumbnailRevisionRegistry', () => {
  it('starts every coin at 0, which is the "URL unchanged" case', () => {
    const registry = new CoinThumbnailRevisionRegistry();
    expect(registry.revisionOf('morgan')).toBe(0);
  });

  it('moves only the coin whose images were confirmed', () => {
    const registry = new CoinThumbnailRevisionRegistry();
    registry.bump('morgan');

    expect(registry.revisionOf('morgan')).toBe(1);
    expect(registry.revisionOf('peace')).toBe(0);
  });

  it('keeps moving, so a second photo change is a third distinct URL', () => {
    const registry = new CoinThumbnailRevisionRegistry();
    registry.bump('morgan');
    registry.bump('morgan');
    expect(registry.revisionOf('morgan')).toBe(2);
  });
});

describe('which writes count as touching the images', () => {
  it('counts a payload carrying imagePaths', () => {
    expect(writeTouchesImages({ imagePaths: [PHOTO] })).toBe(true);
  });

  it('counts an EMPTY imagePaths array — deleting the last photo changes the thumbnail too', () => {
    expect(writeTouchesImages({ imagePaths: [] })).toBe(true);
  });

  it('does not count an edit to some other field', () => {
    expect(writeTouchesImages({ grade: 'MS64' })).toBe(false);
    expect(writeTouchesImages({})).toBe(false);
    expect(writeTouchesImages(null)).toBe(false);
  });
});

describe('ApiService.coinThumbnailUrl', () => {
  it('is unchanged at revision 0, so an untouched coin still revalidates with a 304', () => {
    const api = realApiService();
    expect(api.coinThumbnailUrl('morgan-1921'))
      .toBe(api.coinThumbnailUrl('morgan-1921', 0));
    expect(api.coinThumbnailUrl('morgan-1921')).not.toContain('?');
  });

  it('produces a DIFFERENT url once the images have changed', () => {
    const api = realApiService();
    expect(api.coinThumbnailUrl('morgan-1921', 1))
      .not.toBe(api.coinThumbnailUrl('morgan-1921', 0));
    expect(api.coinThumbnailUrl('morgan-1921', 2))
      .not.toBe(api.coinThumbnailUrl('morgan-1921', 1));
  });

  it('still escapes the coin id', () => {
    const api = realApiService();
    expect(api.coinThumbnailUrl('a/b?c', 3)).toContain('a%2Fb%3Fc');
  });
});

describe('CoinEditor bumps the revision only when the server confirms', () => {
  beforeEach(() => {
    coinThumbnailRevisions.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    coinThumbnailRevisions.clear();
  });

  it('does NOT bump on the optimistic paint — the server has no picture yet', async () => {
    const { inv } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    inv.updateCoin('c1', { imagePaths: [PHOTO] });

    // The row shows the photo, but the PUT hasn't been sent yet.
    expect(coinThumbnailRevisions.revisionOf('c1')).toBe(0);
  });

  it('bumps once the PUT that carried the images comes back', async () => {
    const { inv } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    inv.updateCoin('c1', { imagePaths: [PHOTO] });
    await vi.advanceTimersByTimeAsync(1000);

    expect(coinThumbnailRevisions.revisionOf('c1')).toBe(1);
  });

  it('does not bump for an edit that leaves the photographs alone', async () => {
    const { inv } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [PHOTO] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    inv.updateCoin('c1', { grade: 'MS64' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(coinThumbnailRevisions.revisionOf('c1')).toBe(0);
  });

  it('does not bump when the PUT fails — nothing on the server changed', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    (mockApiService.updateCoin as never as { mockReturnValue(v: unknown): void })
      .mockReturnValue(throwError(() => new Error('server down')));

    inv.updateCoin('c1', { imagePaths: [PHOTO] });
    await vi.advanceTimersByTimeAsync(1000);

    expect(coinThumbnailRevisions.revisionOf('c1')).toBe(0);
  });

  it('bumps again when a SECOND photo is added, so the url moves every time', async () => {
    const { inv } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    inv.updateCoin('c1', { imagePaths: [PHOTO] });
    await vi.advanceTimersByTimeAsync(1000);
    inv.updateCoin('c1', { imagePaths: [PHOTO, SECOND_PHOTO] });
    await vi.advanceTimersByTimeAsync(1000);

    expect(coinThumbnailRevisions.revisionOf('c1')).toBe(2);
  });

  it("bumps when a draft's create lands carrying photographs", async () => {
    const { inv, mockApiService } = createTestInventoryService();
    (mockApiService.createCoin as never as { mockReturnValue(v: unknown): void })
      .mockReturnValue(of({ id: 'ok' }));

    const coin = inv.addBlankCoin();
    inv.updateCoin(coin.id, { year: '1921', denomination: 'Dollar', imagePaths: [PHOTO] });
    await vi.advanceTimersByTimeAsync(1000);

    expect(inv.isDraftCoin(coin.id)).toBe(false);
    expect(coinThumbnailRevisions.revisionOf(coin.id)).toBe(1);
  });
});

describe('the end-to-end sequence the owner hit', () => {
  beforeEach(() => {
    coinThumbnailRevisions.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    coinThumbnailRevisions.clear();
  });

  it('gives the grid a url it has not already been 404ed on', async () => {
    const api = realApiService();
    const { inv } = createTestInventoryService();
    inv.addCoins([{ id: 'c1', denomination: 'Dollar', year: '1921', imagePaths: [] } as never]);
    await vi.advanceTimersByTimeAsync(0);

    // The user attaches a photo; the browser requests this URL before the server
    // has the image (a 404).
    inv.updateCoin('c1', { imagePaths: [PHOTO] });
    const urlRequestedTooEarly = api.coinThumbnailUrl('c1', coinThumbnailRevisions.revisionOf('c1'));

    // A second later the PUT lands.
    await vi.advanceTimersByTimeAsync(1000);
    const urlAfterTheSave = api.coinThumbnailUrl('c1', coinThumbnailRevisions.revisionOf('c1'));

    // The URL must change after the save so the browser requests the photo again.
    expect(urlAfterTheSave).not.toBe(urlRequestedTooEarly);
  });
});

describe('the mock ApiService used by every other test', () => {
  it('accepts the revision argument, so the grid helper can pass it', () => {
    const { mockApiService } = createMockDependencies();
    const withRevision = mockApiService.coinThumbnailUrl('c1', 4);
    const without = mockApiService.coinThumbnailUrl('c1');
    expect(withRevision).not.toBe(without);
  });
});
