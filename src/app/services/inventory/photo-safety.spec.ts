 /*
  * A save must never destroy a coin's photos.
  *
  * `GET /api/coins` omits `imagePaths` (absent, not empty), and a PUT carrying an
  * `imagePaths` key replaces the coin's whole image set (replaceImages in
  * server/routes/coins/write-helpers.ts). If "not loaded" ever became `[]` in a PUT
  * body, every photo would be silently deleted.
  *
  * Two defences: the server omits the key (tested in
  * server/routes/coins/list-query.spec.ts), and the client sends only changed
  * fields, so the server's `hasOwnProperty('imagePaths')` guard leaves images
  * alone. These tests check the second, end to end through the real
  * InventoryService and CoinEditor with only HTTP mocked.
  *
  * `not.toHaveProperty` alone would pass for `{ imagePaths: undefined }`, so the
  * checks also use `Object.keys()` and `in` (how the server decides).
  * Fake timers: CoinEditor debounces its PUT by one second.
  */
import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/**
 * A coin as `GET /api/coins` returns it, with no `imagePaths` key at all (deleted,
 * not set to undefined).
 */
function listLoadedCoin(imageCount: number): CoinRecord {
  const coin = {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    source: 'manual', imageCount
  } as unknown as CoinRecord;

  // Ensures the key is absent even if the literal above gains it.
  delete (coin as { imagePaths?: unknown }).imagePaths;
  return coin;
}

function createHarness(imageCount = 3) {
  const harness = createTestInventoryService();
  harness.inv.inventory.set([listLoadedCoin(imageCount)]);
  harness.inv.selectedCoinId.set('coin-1');
  return harness;
}

/** Every PUT body sent so far. */
function sentPayloads(api: { updateCoin: ReturnType<typeof vi.fn> }): Record<string, unknown>[] {
  return api.updateCoin.mock.calls.map(call => call[1] as Record<string, unknown>);
}

/**
 * The key assertion, stated three ways. `in` matters most: it matches the
 * server's `hasOwnProperty('imagePaths')` guard.
 */
function expectNoImagePathsKey(payload: Record<string, unknown>): void {
  expect(payload).not.toHaveProperty('imagePaths');
  expect(Object.keys(payload)).not.toContain('imagePaths');
  expect('imagePaths' in payload).toBe(false);
}

describe('A save on a coin whose photographs were never loaded', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends NO imagePaths key at all when an unrelated field is edited', () => {
    const { inv, mockApiService } = createHarness();

    // An ordinary text edit on the detail panel.
    inv.updateCoin('coin-1', { notes: 'Bought at the Baltimore show' });
    vi.advanceTimersByTime(1500);

    const payloads = sentPayloads(mockApiService as never);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!['notes']).toBe('Bought at the Baltimore show');
    expectNoImagePathsKey(payloads[0]!);
  });

  it('still sends no imagePaths key after a run of unrelated edits', () => {
    const { inv, mockApiService } = createHarness();

    inv.updateCoin('coin-1', { grade: 'MS65' });
    vi.advanceTimersByTime(1500);
    inv.updateCoin('coin-1', { currentValue: 999 });
    vi.advanceTimersByTime(1500);
    inv.updateCoin('coin-1', { notes: 'regraded' });
    vi.advanceTimersByTime(1500);

    const payloads = sentPayloads(mockApiService as never);
    expect(payloads).toHaveLength(3);
    for (const payload of payloads) expectNoImagePathsKey(payload);
  });

  it('sends no imagePaths key when several fields change in one edit', () => {
    const { inv, mockApiService } = createHarness();

    inv.updateCoin('coin-1', { grade: 'MS65', certNumber: '87654321', notes: 'x' });
    vi.advanceTimersByTime(1500);

    const payloads = sentPayloads(mockApiService as never);
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).sort()).toEqual(['certNumber', 'grade', 'notes']);
    expectNoImagePathsKey(payloads[0]!);
  });

  it('leaves the record itself without the key — nothing invents an empty array', () => {
    const { inv } = createHarness();

    inv.updateCoin('coin-1', { notes: 'edited' });
    vi.advanceTimersByTime(1500);

    // The on-screen copy must not gain `imagePaths: []`, or a later payload could carry it.
    const live = inv.inventory()[0]!;
    expect('imagePaths' in live).toBe(false);
    expect(live.notes).toBe('edited');
  });

  it('IS able to send imagePaths when the user really does change the photos', () => {
     /*
      * Anti-vacuity: the tests above would also pass if `updateCoin` dropped
      * `imagePaths` from every request or sent nothing, which would break reordering
      * and deleting photos.
      */
    const { inv, mockApiService } = createHarness();

    inv.updateCoin('coin-1', { imagePaths: ['data:image/jpeg;base64,AAA'] });
    vi.advanceTimersByTime(1500);

    const payloads = sentPayloads(mockApiService as never);
    expect(payloads).toHaveLength(1);
    expect('imagePaths' in payloads[0]!).toBe(true);
    expect(payloads[0]!['imagePaths']).toEqual(['data:image/jpeg;base64,AAA']);
  });
});
