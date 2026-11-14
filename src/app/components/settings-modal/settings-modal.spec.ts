import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The template with its comments removed.
 *
 * *** REQUIRED, NOT TIDINESS. *** This template explains at length which
 * reference lists used to be here and why they went, and that explanation
 * NAMES every list the assertions below look for. Asserting against the
 * raw text would match the prose and pass with the chip editors still on
 * screen — which is exactly the failure mode these tests exist to catch.
 */
function settingsTemplate(): string {
  return readFileSync(join(__dirname, 'settings-modal.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

describe('SettingsModal — settings, and nothing else', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  /* THE LISTS MOVED TO REFERENCE DATA.
   *
   * Categories, mint marks and sets/albums were edited in BOTH places, and
   * the Settings copy was the weaker one: a chip removed an entry on one
   * click with no count of the coins using it and no confirmation. Metal
   * content was the only one with no pane on the Reference Data screen, so
   * it was moved there rather than deleted — see
   * category-modal.spec.ts > 'CategoryModal — metal content', which is
   * where the add/remove coverage deleted from this file now lives. */

  it('cannot edit any reference list any more', () => {
    /* Asserted on the CLASS, not only the template: a stale method left
     * behind is a button somebody re-adds to the markup later, and the
     * chips are only a duplicate editor for as long as nobody notices
     * they are still reachable. */
    const { modal } = createModal();
    const asRecord = modal as unknown as Record<string, unknown>;

    for (const gone of [
      'addCategory', 'removeCategory', 'categoryDraft',
      'addMintMark', 'removeMintMarkEntry', 'mintMarkDraft',
      'addMetalContent', 'removeMetalContent', 'metalContentDraft',
      'addCoinSet', 'removeCoinSet', 'coinSetDraft',
      // Denominations were never editable here; the pointer that stood in
      // for them has gone too, with the rest of the section.
      'addDenomination', 'removeDenominationEntry', 'denominationDraft',
    ]) {
      expect(asRecord[gone], `${gone} is still on SettingsModal`).toBeUndefined();
    }

    // The settings themselves are untouched, which is what makes the list
    // above a statement about the reference lists rather than about the
    // component having been gutted.
    expect(typeof asRecord['saveSettings']).toBe('function');
    expect(typeof asRecord['previewPmBackfill']).toBe('function');
  });

  it('has no reference-list markup left in the template', () => {
    const template = settingsTemplate();

    expect(template).not.toContain('Reference lists');
    expect(template).not.toContain('settings-chip-list');
    expect(template).not.toContain('settings-inline-add');
    expect(template).not.toContain('chip-button');
    // The signals the chips were bound to, by name.
    expect(template).not.toContain('categoryDraft');
    expect(template).not.toContain('mintMarkDraft');
    expect(template).not.toContain('metalContentDraft');
    expect(template).not.toContain('coinSetDraft');
    // Including the denominations pointer, which was a list entry too.
    expect(template).not.toContain('inv.denominations()');
  });

  it('offers one route to where the lists went', () => {
    /* NOT optional tidiness. Somebody who learned that categories live in
     * Settings has to be taken to the new screen, not merely told it
     * exists — so this is a button that emits, not a sentence. */
    const template = settingsTemplate();

    expect(template).toContain('referenceDataRequested.emit()');
    expect(template).toContain('Reference Data');
    // Exactly one, so the "single clear route" does not quietly become
    // three links in three sections.
    expect(template.split('referenceDataRequested.emit()').length - 1).toBe(1);
  });

  it('keeps the two things that really are settings', () => {
    const template = settingsTemplate();

    expect(template).toContain('showTransactionsInDetailsChange.emit');
    expect(template).toContain('<h3>Maintenance</h3>');
    expect(template).toContain('previewPmBackfill()');
  });
});

/* MAINTENANCE — backfill precious-metal data.
 *
 * The planner's own rules are tested in services/pm-backfill.spec.ts. What is
 * tested HERE is the part that only exists once the plan is wired to a real
 * InventoryService: that the preview the user confirms is what reaches the
 * backend, that each coin is written exactly once with a minimal payload, and
 * that unrelated columns are never sent. */

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
      // Fillable: the metal is recorded; the four gaps get completed.
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
    /* THE RULE THIS GUARDS: `PUT /api/coins/:id` applies whatever it is
     * given, so sending a whole record blanks out every column the sender
     * did not fill in. The Saint-Gaudens below carries a note and a purchase
     * price that must not appear in the body. */
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
      // 30.09 g of gold above.
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
