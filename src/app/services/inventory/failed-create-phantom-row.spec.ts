/**
 * BUG: a failed coin creation left a phantom row in the grid.
 *
 *   22:55:22 [ERROR] Failed to create coin 423f9821-... | 400 denomination is required
 *   22:56:14 [WARN]  No thumbnail available for coin 423f9821-...
 *
 * The owner added a coin with no denomination. The client's save rule is the
 * 2-of-3 rule (any two of Year / Coin Type / Denomination); the server's rule
 * is `if (!body.denomination) -> 400`. A coin with a Year and a Coin Type
 * passes the first and is refused by the second, so the row sat in the grid
 * being POSTed and refused over and over — silently, because the
 * create-failure toast is de-duplicated per coin — and the grid went on to
 * request a thumbnail for a coin the database had never heard of.
 *
 * The decision taken here is MARK, NOT REMOVE: the row stays on screen (the
 * user typed it, and discarding someone's typing is its own bug) but it is
 * honestly marked unsaved, it says why, and nothing about it pretends to the
 * rest of the app that a database row exists.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';
import {
  canCreateCoin,
  meetsServerCreateRules,
  describeMissingServerRequirement
} from './coin-create-requirements';

function mockReturn(fn: unknown, value: unknown): void {
  (fn as { mockReturnValue(v: unknown): void }).mockReturnValue(value);
}

describe('the create gate agrees with what POST /api/coins will accept', () => {
  it('refuses the exact record the owner created: year + type, no denomination', () => {
    expect(canCreateCoin({ year: '1921', coinType: 'Morgan' })).toBe(false);
  });

  it('still accepts everything it accepted before', () => {
    expect(canCreateCoin({ year: '1921', denomination: 'Dollar' })).toBe(true);
    expect(canCreateCoin({ coinType: 'Morgan', denomination: 'Dollar' })).toBe(true);
  });

  it('mirrors the server truthiness check and nothing stricter', () => {
    // The server says `if (!body.denomination)`. "Other" is truthy, so the
    // server stores it; the stricter coin-completeness placeholder test would
    // not, and using that here would stop coins saving that save today.
    expect(meetsServerCreateRules({ denomination: 'Other' })).toBe(true);
    expect(meetsServerCreateRules({ denomination: '' })).toBe(false);
    expect(meetsServerCreateRules({})).toBe(false);
  });

  it('still refuses a fragment even when it has a denomination', () => {
    expect(canCreateCoin({ denomination: 'Dollar' })).toBe(false);
  });

  it('explains the missing requirement rather than failing mutely', () => {
    expect(describeMissingServerRequirement({ year: '1921', coinType: 'Morgan' }))
      .toContain('Denomination');
    expect(describeMissingServerRequirement({ denomination: 'Dollar' })).toBe('');
  });
});

describe('a draft the server would refuse is never POSTed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends no request for year + coin type with no denomination', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    const coin = inv.addBlankCoin();

    inv.updateCoin(coin.id, { year: '1921', coinType: 'Morgan' });
    await vi.advanceTimersByTimeAsync(5000);

    // Before the fix this POSTed and came back 400 every time.
    expect(mockApiService.createCoin).not.toHaveBeenCalled();
    expect(inv.isDraftCoin(coin.id)).toBe(true);
  });

  it('tells the user what the row is waiting for', async () => {
    const { inv } = createTestInventoryService();
    const coin = inv.addBlankCoin();

    inv.updateCoin(coin.id, { year: '1921', coinType: 'Morgan' });
    await vi.advanceTimersByTimeAsync(5000);

    const hint = inv.draftHint(inv.inventory()[0]);
    expect(hint).not.toBe('');
    expect(hint).toContain('Denomination');
  });

  it('saves the moment the denomination is supplied', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    const coin = inv.addBlankCoin();

    inv.updateCoin(coin.id, { year: '1921', coinType: 'Morgan' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockApiService.createCoin).not.toHaveBeenCalled();

    inv.updateCoin(coin.id, { denomination: 'Dollar' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockApiService.createCoin).toHaveBeenCalledTimes(1);
    expect(inv.isDraftCoin(coin.id)).toBe(false);
    expect(inv.draftHint(inv.inventory()[0])).toBe('');
  });
});

describe('a create that fails for some OTHER reason stays visible and honest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps the row, marks it unsaved, and says why on the row itself', async () => {
    const { inv, mockApiService, mockNotification } = createTestInventoryService();
    mockReturn(mockApiService.createCoin, throwError(() => new Error('server down')));

    const coin = inv.addBlankCoin();
    inv.updateCoin(coin.id, { year: '1921', denomination: 'Dollar' });
    await vi.advanceTimersByTimeAsync(1000);

    // The typing is not thrown away...
    expect(inv.inventory()).toHaveLength(1);
    expect(inv.inventory()[0].year).toBe('1921');
    // ...but the row does not pretend to be saved.
    expect(inv.isDraftCoin(coin.id)).toBe(true);
    expect(mockNotification.showError).toHaveBeenCalledTimes(1);

    // The toast is transient; the row's own hint is not.
    const hint = inv.draftHint(inv.inventory()[0]);
    expect(hint).not.toBe('');
    expect(hint.toLowerCase()).toContain('failed');
  });

  it('clears the failure hint once the retry succeeds', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    mockReturn(mockApiService.createCoin, throwError(() => new Error('server down')));

    const coin = inv.addBlankCoin();
    inv.updateCoin(coin.id, { year: '1921', denomination: 'Dollar' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(inv.draftHint(inv.inventory()[0])).not.toBe('');

    mockReturn(mockApiService.createCoin, of({ id: coin.id }));
    inv.updateCoin(coin.id, { coinType: 'Morgan' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(inv.isDraftCoin(coin.id)).toBe(false);
    expect(inv.draftHint(inv.inventory()[0])).toBe('');
  });
});

describe('the same hole on the BULK create path (imports)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const imported = (id: string): CoinRecord =>
    ({ id, year: '1921', coinType: 'Morgan', denomination: 'Dollar', imagePaths: [] }) as CoinRecord;

  it('marks an imported coin unsaved when its POST fails, instead of leaving a phantom row', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    mockReturn(mockApiService.createCoin, throwError(() => new Error('server down')));

    inv.addCoins([imported('bulk-1')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(inv.inventory()).toHaveLength(1);
    // Before the fix this was false: the change tracker had been seeded with
    // a "confirmed" baseline for a row the server never accepted, so the next
    // edit PUT to a coin that does not exist and 404ed forever.
    expect(inv.isDraftCoin('bulk-1')).toBe(true);
  });

  it('retries the create — not a doomed PUT — on the next edit', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    mockReturn(mockApiService.createCoin, throwError(() => new Error('server down')));

    inv.addCoins([imported('bulk-1')]);
    await vi.advanceTimersByTimeAsync(0);

    mockReturn(mockApiService.createCoin, of({ id: 'bulk-1' }));
    inv.updateCoin('bulk-1', { grade: 'MS64' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
    expect(mockApiService.createCoin).toHaveBeenCalledTimes(2);
    expect(inv.isDraftCoin('bulk-1')).toBe(false);
  });

  it('leaves a coin whose POST succeeded completely alone', async () => {
    const { inv } = createTestInventoryService();

    inv.addCoins([imported('bulk-ok')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(inv.isDraftCoin('bulk-ok')).toBe(false);
  });
});
