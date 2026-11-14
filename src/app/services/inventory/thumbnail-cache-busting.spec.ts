/**
 * BUG: a newly added image showed as a broken thumbnail until the grid was
 * reloaded.
 *
 * The grid's row thumbnail is `<img src="/api/coins/<id>/thumbnail">`, and
 * that URL used to depend on nothing but the coin id. Attaching a photo
 * paints the new `imagePaths` array on screen immediately but only PUTs it a
 * second later, so the browser requested the thumbnail while the server still
 * had no image, got a 404, and never asked again — the element, and the URL,
 * were unchanged by the save that followed.
 *
 * These tests pin the three halves of the fix:
 *   1. the registry only moves when the SERVER confirms an image write,
 *   2. CoinEditor bumps it from the success handler of a create/update that
 *      carried `imagePaths`, and from nowhere else,
 *   3. ApiService turns a non-zero revision into a different URL while
 *      leaving revision 0 byte-identical to what it has always produced (so
 *      an unchanged coin still revalidates with a 304 rather than
 *      re-downloading).
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
 * The real ApiService with a stub HttpClient — `coinThumbnailUrl` builds a
 * string and makes no request, so nothing else is needed. Constructed the
 * same way api.service.spec.ts does it, for the same reason: importing
 * Angular's HTTP testing module here would drag in the XHR backend.
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

    // The row already shows the photo, but the PUT has not even left yet.
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

    // The user attaches a photo. The row repaints at once and the browser
    // asks for THIS url while the server still has nothing: a 404.
    inv.updateCoin('c1', { imagePaths: [PHOTO] });
    const urlRequestedTooEarly = api.coinThumbnailUrl('c1', coinThumbnailRevisions.revisionOf('c1'));

    // A second later the PUT lands.
    await vi.advanceTimersByTimeAsync(1000);
    const urlAfterTheSave = api.coinThumbnailUrl('c1', coinThumbnailRevisions.revisionOf('c1'));

    // Before the fix these two were the same string, which is exactly why
    // nothing re-requested the picture and the thumbnail stayed broken.
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
