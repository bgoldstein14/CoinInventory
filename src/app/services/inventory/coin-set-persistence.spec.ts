/**
 * Tests that adding or removing a Set / Album reaches the DATABASE.
 *
 * THE BUG THESE EXIST FOR
 * -----------------------
 * `LookupManager.addCoinSet` and `removeCoinSet` used to update the in-memory
 * signal and stop there. A comment claimed that was deliberate — "a coin set
 * exists because some coin references it" — but the app has a CoinSets table,
 * `/api/coin-sets` routes, and hydration that READS from them. Only the write
 * half was missing.
 *
 * The user-visible result: add a set, see it in the picker, reload, and it is
 * gone, because hydration replaced the local list with the database's copy
 * which had never been told. A set created before any coin was filed into it
 * could never survive at all.
 */
import { describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import { createTestInventoryService } from '../../testing/test-helpers';

/** Let the fire-and-forget `.then()/.catch()` on the API call settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('coin set persistence', () => {
  it('adds the set locally AND posts it to the backend', async () => {
    const { inv, mockApiService } = createTestInventoryService();

    inv.addCoinSet('Morgan Set');
    await settle();

    expect(inv.coinSets()).toContain('Morgan Set');
    expect(mockApiService.createCoinSet).toHaveBeenCalledWith('Morgan Set');
  });

  it('removes the set locally AND deletes it on the backend', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    inv.coinSets.set(['Morgan Set', 'Type Set']);

    inv.removeCoinSet('Morgan Set');
    await settle();

    expect(inv.coinSets()).toEqual(['Type Set']);
    expect(mockApiService.deleteCoinSet).toHaveBeenCalledWith('Morgan Set');
  });

  it('does not post a duplicate, which the backend would reject', async () => {
    // CoinSets is keyed on the name, so a second POST of the same value is a
    // primary-key clash rather than a harmless no-op.
    const { inv, mockApiService } = createTestInventoryService();
    inv.coinSets.set(['Morgan Set']);

    inv.addCoinSet('Morgan Set');
    await settle();

    expect(mockApiService.createCoinSet).not.toHaveBeenCalled();
    expect(inv.coinSets()).toEqual(['Morgan Set']);
  });

  it('trims surrounding whitespace before storing or sending', async () => {
    const { inv, mockApiService } = createTestInventoryService();

    inv.addCoinSet('  Proof Set  ');
    await settle();

    expect(inv.coinSets()).toContain('Proof Set');
    expect(mockApiService.createCoinSet).toHaveBeenCalledWith('Proof Set');
  });

  it('ignores a blank or whitespace-only name entirely', async () => {
    const { inv, mockApiService } = createTestInventoryService();

    inv.addCoinSet('   ');
    inv.addCoinSet('');
    await settle();

    expect(inv.coinSets()).toEqual([]);
    expect(mockApiService.createCoinSet).not.toHaveBeenCalled();
  });

  it('keeps the list sorted so the picker is predictable', async () => {
    const { inv } = createTestInventoryService();

    inv.addCoinSet('Type Set');
    inv.addCoinSet('Album A');
    await settle();

    expect(inv.coinSets()).toEqual(['Album A', 'Type Set']);
  });

  it('tells the user when the save fails instead of diverging silently', async () => {
    // The local signal is updated optimistically, so a failed write would
    // otherwise leave the UI showing a set the database does not have.
    const { inv, mockApiService, mockNotification } = createTestInventoryService();

    // A failing REQUEST, not a synchronous throw: the error has to arrive
    // through the observable so it lands in the `.catch()` on firstValueFrom,
    // which is the path the real backend failure takes.
    // Cast because the shared mock object types this as a plain function
    // rather than a vi.Mock; the same `as any` appears on the other mocks in
    // this suite for the same reason.
    (mockApiService.createCoinSet as any).mockReturnValue(throwError(() => new Error('network down')));

    expect(() => inv.addCoinSet('Morgan Set')).not.toThrow();
    await settle();

    expect(mockNotification.showError).toHaveBeenCalled();
    // The optimistic local add stands; the notification is what tells the user
    // the two are out of step.
    expect(inv.coinSets()).toContain('Morgan Set');
  });
});
