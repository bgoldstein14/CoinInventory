import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { InventoryService } from '../../services/inventory.service';
import { StorageService } from '../../services/storage.service';
import { SettingsModal } from './settings-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { CoinRecord } from '../../types/coin.model';
import { PM_FIELD_KEYS } from '../../services/pm-fill';

/**
 * SettingsModal uses inject() for InventoryService and StorageService, so it
 * must be created inside an injection context — the same pattern the other
 * component specs use.
 */
function createModal() {
  const { inv, storage, mockApiService } = createTestInventoryService();
  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: StorageService, useValue: storage }
    ]
  });
  const modal = runInInjectionContext(injector, () => new SettingsModal());
  return { modal, inv, mockApiService };
}

describe('SettingsModal', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // Moved here from app.spec.ts along with the code it exercises.
  it('allows category maintenance from settings', () => {
    const { modal, inv } = createModal();

    modal['categoryDraft'].set('Custom Category');
    modal['addCategory']();
    expect(inv.categoryOptions()).toContain('Custom Category');

    modal['removeCategory']('Custom Category');
    expect(inv.categoryOptions()).not.toContain('Custom Category');
  });

  it('applies a metal content edit straight to the live list', () => {
    // This used to also assert that a bulk-edit textarea had been refreshed to
    // match. Those textareas are gone: they duplicated the chips and were the
    // source of a family of bugs -- rebuilding a reference record from a line
    // of text discarded its country, its id, and (for denominations) its real
    // label, which is what emptied the denomination dropdown. The chips apply
    // and persist one entry at a time, so there is no second copy of the list
    // left to go stale.
    const { modal, inv } = createModal();

    modal['metalContentDraft'].set('Electrum');
    modal['addMetalContent']();

    expect(inv.metalContents()).toContain('Electrum');

    modal['removeMetalContent']('Electrum');
    expect(inv.metalContents()).not.toContain('Electrum');
  });

  it('adds a denomination under US, the code the data actually uses', () => {
    // 'United States' here was the reported bug: the coin editor groups its
    // dropdown by this value and the seeded rows use 'US', so a full country
    // name filed the new entry under a group of its own and the dropdown
    // showed headings with nothing under them.
    //
    // The assertion is on what gets SENT, not on what lands in the signal:
    // addDenomination stores whatever the server echoes back, so checking the
    // local list would be testing the mock rather than this component.
    const { modal, mockApiService } = createModal();
    mockApiService.createDenomination = vi.fn(() => of({
      denominationId: 99, label: 'Crown', country: 'US', sortOrder: 10, isActive: true
    }));

    modal['denominationDraft'].set('Crown');
    modal['addDenomination']();

    expect(mockApiService.createDenomination).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Crown', country: 'US' })
    );
  });

  it('ignores blank drafts', () => {
    const { modal, inv } = createModal();

    modal['categoryDraft'].set('   ');
    modal['addCategory']();
    expect(inv.categoryOptions()).toHaveLength(0);

    modal['metalContentDraft'].set('   ');
    const before = inv.metalContents().length;
    modal['addMetalContent']();
    expect(inv.metalContents()).toHaveLength(before);
  });
});

/* ===========================================================================
 * MAINTENANCE — backfill precious-metal data
 * ---------------------------------------------------------------------------
 * The planner's own rules are tested in services/pm-backfill.spec.ts. What is
 * tested HERE is the part that only exists once the plan is wired to a real
 * InventoryService: that the preview the user confirms is what reaches the
 * backend, that each coin is written exactly once with a minimal payload, and
 * that unrelated columns are never sent.
 * ======================================================================== */

/** A coin with everything blank except whatever the test overrides. */
function coin(overrides: Partial<CoinRecord>): CoinRecord {
  return {
    id: 'c1',
    denomination: '',
    year: '',
    coinType: '',
    category: '',
    country: 'United States',
    grade: '',
    certCompany: '',
    certNumber: '',
    variety: '',
    mintMark: '',
    composition: '',
    purchaseDate: '',
    purchasePrice: 0,
    currentValue: 0,
    notes: '',
    imagePaths: [],
    source: 'manual',
    ...overrides
  };
}

describe('SettingsModal — precious-metal backfill', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /** One of each kind of coin, so every preview bucket has a member. */
  function loadMixedInventory(inv: InventoryService): void {
    inv.inventory.set([
      // Fillable: nothing recorded at all.
      coin({ id: 'saint', denomination: '$20', year: '1927', notes: 'bought at auction' }),
      // Fillable: the owner typed the metal; the four gaps get completed.
      coin({ id: 'kennedy', denomination: '50¢', year: '1964', metalContent: 'Silver' }),
      // Already complete: all five present, gross Weight included. Without
      // the weight this coin would become fillable and stop being the
      // "nothing to do" member of the mix.
      coin({
        id: 'eagle',
        denomination: '$10',
        year: '1901',
        metalContent: 'Gold',
        composition: '90% Gold, 10% Copper',
        pmPercent: 90,
        pmWeightGrams: 15.05,
        weight: 16.718
      }),
      // Undetermined: the 1942 nickel was struck in BOTH cupronickel and 35%
      // silver, and nothing in the record says which.
      coin({ id: 'warnickel', denomination: '5¢', year: '1942' })
    ]);
  }

  it('previews counts without writing anything', () => {
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();

    const plan = modal['backfillPlan']();
    expect(plan?.fillableCount).toBe(2);
    expect(plan?.alreadyCompleteCount).toBe(1);
    expect(plan?.undeterminedCount).toBe(1);
    expect(plan?.totalScanned).toBe(4);

    // The confirm has not been pressed, so nothing may have been sent.
    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
  });

  it('writes exactly the coins the preview promised, one PUT each', async () => {
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();
    const promised = modal['backfillPlan']()!.fillableCount;

    await modal['confirmPmBackfill']();

    expect(mockApiService.updateCoin).toHaveBeenCalledTimes(promised);

    const ids = (mockApiService.updateCoin as unknown as { mock: { calls: [string, object][] } })
      .mock.calls.map(([id]) => id);
    expect(ids.sort()).toEqual(['kennedy', 'saint']);
    // Exactly once each — no coin written twice.
    expect(new Set(ids).size).toBe(ids.length);

    const outcome = modal['backfillOutcome']();
    expect(outcome?.filled).toBe(promised);
    expect(outcome?.failed).toBe(0);
  });

  it('sends ONLY precious-metal fields in each payload', async () => {
    /* THE RULE THIS GUARDS: `PUT /api/coins/:id` applies whatever it is given,
     * and this project has previously blanked out columns by sending whole
     * records. The Saint-Gaudens below carries a note and a purchase price
     * that must not appear in the body. */
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();
    await modal['confirmPmBackfill']();

    const calls = (mockApiService.updateCoin as unknown as {
      mock: { calls: [string, Record<string, unknown>][] };
    }).mock.calls;

    for (const [, payload] of calls) {
      for (const key of Object.keys(payload)) {
        expect(PM_FIELD_KEYS).toContain(key);
      }
    }

    const saint = calls.find(([id]) => id === 'saint')![1];
    expect(saint).toEqual({
      metalContent: 'Gold',
      composition: '90% Gold, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 30.09,
      // The coin's GROSS weight in grams — a different number from the
      // 30.09 g of gold above, and the fifth field the backfill now writes.
      weight: 33.436
    });
    expect(saint).not.toHaveProperty('notes');
    expect(saint).not.toHaveProperty('purchasePrice');
  });

  it('never re-sends a field the coin already had', async () => {
    // The Kennedy half already says "Silver". That value must not appear in
    // the payload at all — not even set to the same string — because the
    // backfill has no business writing over a hand-entered figure.
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();
    await modal['confirmPmBackfill']();

    const calls = (mockApiService.updateCoin as unknown as {
      mock: { calls: [string, Record<string, unknown>][] };
    }).mock.calls;
    const kennedy = calls.find(([id]) => id === 'kennedy')![1];

    expect(kennedy).not.toHaveProperty('metalContent');
    expect(kennedy).toEqual({
      composition: '90% Silver, 10% Copper',
      pmPercent: 90,
      pmWeightGrams: 11.25,
      weight: 12.50
    });

    // ...and the on-screen value is untouched.
    expect(inv.inventory().find(c => c.id === 'kennedy')?.metalContent).toBe('Silver');
  });

  it('leaves an ambiguous coin exactly as it was', async () => {
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);
    const before = { ...inv.inventory().find(c => c.id === 'warnickel')! };

    modal['previewPmBackfill']();
    await modal['confirmPmBackfill']();

    const ids = (mockApiService.updateCoin as unknown as { mock: { calls: [string][] } })
      .mock.calls.map(([id]) => id);
    expect(ids).not.toContain('warnickel');
    expect(inv.inventory().find(c => c.id === 'warnickel')).toEqual(before);
  });

  it('paints the filled values onto the screen as well as saving them', async () => {
    // The melt column reads from the live inventory signal, so the figures
    // must appear without a reload.
    const { modal, inv } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();
    await modal['confirmPmBackfill']();

    const saint = inv.inventory().find(c => c.id === 'saint')!;
    expect(saint.pmWeightGrams).toBe(30.09);
    expect(saint.metalContent).toBe('Gold');
    expect(inv.meltValue({ ...saint })).toBeNull();   // no spot prices loaded yet

    inv.updateSpotPrices({ gold: 2000, silver: 0, platinum: 0, copper: 0 });
    expect(inv.meltValue(inv.inventory().find(c => c.id === 'saint')!)).toBeCloseTo(
      (30.09 / 31.1035) * 2000,
      4
    );
  });

  it('reports the coins that failed instead of giving up', async () => {
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);
    mockApiService.updateCoin = vi.fn((id: string) =>
      id === 'kennedy' ? throwError(() => new Error('row is locked')) : of(undefined)
    ) as unknown as typeof mockApiService.updateCoin;

    modal['previewPmBackfill']();
    await modal['confirmPmBackfill']();

    const outcome = modal['backfillOutcome']();
    expect(outcome?.attempted).toBe(2);
    expect(outcome?.filled).toBe(1);
    expect(outcome?.failed).toBe(1);
    expect(outcome?.failures[0].coinId).toBe('kennedy');
  });

  it('does nothing when there is nothing to fill', async () => {
    const { modal, inv, mockApiService } = createModal();
    inv.inventory.set([coin({ id: 'warnickel', denomination: '5¢', year: '1942' })]);

    modal['previewPmBackfill']();
    expect(modal['backfillPlan']()?.fillableCount).toBe(0);

    await modal['confirmPmBackfill']();
    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
  });

  it('clears the preview when cancelled, without writing', async () => {
    const { modal, inv, mockApiService } = createModal();
    loadMixedInventory(inv);

    modal['previewPmBackfill']();
    modal['cancelPmBackfill']();

    expect(modal['backfillPlan']()).toBeNull();
    await modal['confirmPmBackfill']();
    expect(mockApiService.updateCoin).not.toHaveBeenCalled();
  });
});
