 /*
 * photo-safety.spec.ts — "a save must never destroy a coin's photographs".
 * ---- THE DANGER THIS FILE EXISTS FOR ----
 * `GET /api/coins` no longer returns `imagePaths`. The key is ABSENT, not
 * empty, and the distinction is the difference between a working app and a
 * destroyed photo collection:
 *
 *   `PUT /api/coins/:id` carrying an `imagePaths` key REPLACES the coin's
 *   whole image set. It DELETEs every CoinImages row and re-inserts the array
 *   it was handed (server/routes/coins/write-helpers.ts, replaceImages).
 *
 * So if ANY part of the client ever turns "not loaded" into `[]` and lets it
 * reach a PUT body, every photograph on that coin is deleted. Silently. With
 * a 200 response. On the owner's real, irreplaceable collection.
 *
 * ---- THE TWO DEFENCES, AND WHY BOTH ARE PINNED HERE ----
 * 1. THE SERVER OMITS THE KEY rather than sending `imagePaths: undefined` or
 *    `imagePaths: []` (list-query.ts). Pinned on the server side in
 *    server/routes/coins/list-query.spec.ts.
 *
 * 2. THE CLIENT SENDS ONLY CHANGED FIELDS. CoinChangeTracker builds the PUT
 *    body from its dirty-field set and from nothing else, so a field the user
 *    never touched is not in the request at all — and the server's
 *    `hasOwnProperty('imagePaths')` guard then leaves the images alone.
 *
 * Defence 2 is what the tests below assert, end to end through the real
 * InventoryService and the real CoinEditor, with only the HTTP layer mocked.
 *
 * ---- WHY `not.toHaveProperty` IS NOT ENOUGH ON ITS OWN ----
 * `expect(payload).not.toHaveProperty('imagePaths')` passes for a payload of
 * `{ imagePaths: undefined }`, and `JSON.stringify` would drop that key — so
 * it would even be harmless TODAY. It would stop being harmless the moment
 * anything serialises differently. The assertions below therefore check
 * `Object.keys()` and the `in` operator too, which is also precisely how the
 * server decides whether to touch the images.
 *
 * Fake timers: CoinEditor debounces its PUT by one second.
  */
import 'fake-indexeddb/auto';
import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';

/**
 * A coin exactly as `GET /api/coins` now hands it over: every text field, an
 * `imageCount`, and NO `imagePaths` key whatsoever.
 *
 * Built by deleting the key rather than by setting it to undefined, because
 * the whole point is that the property must not exist.
 */
function listLoadedCoin(imageCount: number): CoinRecord {
  const coin = {
    id: 'coin-1', denomination: 'Dollar', year: '1921', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS64', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 100, currentValue: 150, notes: '',
    source: 'manual', imageCount
  } as unknown as CoinRecord;

  // Belt and braces: if the literal above ever gains the key, this spec must
  // still be testing a record that genuinely lacks it.
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
 * The assertion this whole file is about, in one place and stated three ways.
 *
 * `in` is the one that matters most: it is the JavaScript equivalent of the
 * server's `hasOwnProperty('imagePaths')` guard, which is what decides
 * whether the photographs are deleted.
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

    // The ordinary thing a user does: type in a text box on the detail panel.
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

    // The optimistic on-screen copy must not gain `imagePaths: []` either.
    // That is how the empty array would get into a LATER payload.
    const live = inv.inventory()[0]!;
    expect('imagePaths' in live).toBe(false);
    expect(live.notes).toBe('edited');
  });

  it('IS able to send imagePaths when the user really does change the photos', () => {
     /*
     * The anti-vacuity test. Everything above would also pass if `updateCoin`
     * silently dropped `imagePaths` from every request, or if no request were
     * ever sent at all — and either of those would be a worse bug than the
     * one being prevented, because re-ordering and deleting photographs both
     * work by sending the full array.
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
