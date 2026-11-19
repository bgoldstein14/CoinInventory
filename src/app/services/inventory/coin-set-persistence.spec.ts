/**
 * Adding or removing a Set / Album must reach the database (CoinSets table,
 * `/api/coin-sets`). Hydration reads from it, so a set only updated locally
 * would vanish on reload.
 */
import { describe, expect, it } from 'vitest';
import { throwError } from 'rxjs';
import { createTestInventoryService } from '../../testing/test-helpers';

/** Lets the fire-and-forget `.then()/.catch()` on the API call settle. */
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
    // CoinSets is keyed on the name, so a duplicate POST would be a primary-key clash.
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
    // The signal updates optimistically, so a failed write must be reported.
    const { inv, mockApiService, mockNotification } = createTestInventoryService();

    // Fail through the observable (not a synchronous throw), as a real backend does.
    // `as any` because the shared mock types this as a plain function.
    (mockApiService.createCoinSet as any).mockReturnValue(throwError(() => new Error('network down')));

    expect(() => inv.addCoinSet('Morgan Set')).not.toThrow();
    await settle();

    expect(mockNotification.showError).toHaveBeenCalled();
    // The optimistic add stands; the notification reports the mismatch.
    expect(inv.coinSets()).toContain('Morgan Set');
  });
});
