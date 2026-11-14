import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import { AppSettings } from '../../features/app-settings';
import { SettingsModal } from './settings-modal';
import { createTestInventoryService } from '../../testing/test-helpers';
import { CoinRecord } from '../../types/coin.model';
import { PM_FIELD_KEYS } from '../../services/pm-fill';

/**
 * SettingsModal uses inject() for InventoryService and StorageService, so it
 * must be created inside an injection context — the same pattern the other
 * component specs use.
 */
function createModal(apiOverrides: Record<string, unknown> = {}) {
  const { inv, storage, mockApiService } = createTestInventoryService();

  /* §16's backup panel calls ApiService directly (the modal is the only
   * consumer of those six endpoints, so routing them through
   * InventoryService would add six pass-throughs to say nothing new), so
   * the injector has to carry it. The defaults below are the quiet ones:
   * a suggestion that resolves, and nothing else called. A test that
   * cares passes its own.
   *
   * `getBackupSuggestion` in particular is called from the CONSTRUCTOR,
   * so every test in this file goes through it whether it cares or not —
   * a missing stub would fail forty unrelated cases with
   * "api.getBackupSuggestion is not a function". */
  const api = {
    getBackupSuggestion: vi.fn(() =>
      of({
        directory: 'C:\\Users\\You\\Desktop',
        fileName: 'coin-inventory-backup-2026-11-14-1432.db',
        databasePath: 'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.db',
        databaseSizeBytes: 612_300_000
      })
    ),
    startBackup: vi.fn(() => of(runningJob())),
    getBackupJob: vi.fn(() => of(finishedJob())),
    cancelBackup: vi.fn(() => of({ accepted: true })),
    inspectBackup: vi.fn(() => of(goodInspection())),
    restoreBackup: vi.fn(() => of(restoreResult())),
    ...apiOverrides
  };

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: StorageService, useValue: storage },
      { provide: ApiService, useValue: api }
    ]
  });
  const modal = runInInjectionContext(injector, () => new SettingsModal());

  /* `showTransactionsInDetails` is a REQUIRED input and these specs build the
   * component by hand rather than through TestBed, so there is no template to
   * bind it. Reading an unset required input throws, and saveSettings() reads
   * it — so it is stubbed with a plain getter function, which is all the
   * component ever does with it. */
  (modal as unknown as Record<string, unknown>)['showTransactionsInDetails'] = () => false;

  return { modal, inv, storage, mockApiService, api };
}

/* ---- Fixtures for the §16 panel ---- */

function runningJob() {
  return {
    id: 'job-1',
    state: 'running',
    destination: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
    percent: 0,
    totalPages: 10,
    copiedPages: 0,
    startedAt: '2026-11-14T10:00:00.000Z',
    finishedAt: null,
    result: null,
    error: null
  };
}

function finishedJob() {
  return {
    ...runningJob(),
    state: 'done',
    percent: 100,
    finishedAt: '2026-11-14T10:00:05.000Z',
    result: {
      path: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
      fileSizeBytes: 612_300_000,
      pagesCopied: 10,
      coinCount: 412,
      takenAt: '2026-11-14T10:00:05.000Z',
      schemaVersion: 1
    }
  };
}

function goodInspection(overrides: Record<string, unknown> = {}) {
  return {
    path: 'C:\\Users\\You\\Desktop\\backup.db',
    fileSizeBytes: 612_300_000,
    decision: { verdict: 'ok', acceptable: true, message: 'fine', missingTables: [] },
    schemaVersion: 1,
    coinCount: 412,
    imageCount: 0,
    storedImageCount: 0,
    referencedOnlyImageCount: 0,
    referencedFolders: [],
    provenance: { takenAt: '2026-11-14T09:15:00.000Z', recordedCoinCount: 412 },
    ...overrides
  };
}

function restoreResult(overrides: Record<string, unknown> = {}) {
  return {
    restoredFrom: 'C:\\Users\\You\\Desktop\\backup.db',
    databasePath: 'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.db',
    previousCollectionMovedTo:
      'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.replaced-2026-11-14-162030.db',
    coinCount: 412,
    referencedOnlyImageCount: 0,
    missingPhotoFolders: [],
    takenAt: '2026-11-14T09:15:00.000Z',
    serverRestartRequired: false,
    ...overrides
  };
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

  it('does NOT signpost Reference Data any more', () => {
    /* REMOVED AT THE OWNER'S WORD, 2026-11-14: "not really needed since
     * there's an obvious button already on screen." The notice and its
     * button stood here for one day.
     *
     * Asserted on the CLASS as well as the template, for the same reason as
     * the chip editors above: a stale output left behind is a button
     * somebody re-adds to the markup later. And it is not to come back in a
     * smaller form — a quiet one-line link is the same signpost in a
     * lighter font, which is why the assertion is on the WORDS and not only
     * on the button. */
    const { modal } = createModal();
    const template = settingsTemplate();

    expect((modal as unknown as Record<string, unknown>)['referenceDataRequested']).toBeUndefined();
    expect(template).not.toContain('referenceDataRequested');
    expect(template).not.toContain('Open Reference Data');
    expect(template).not.toContain('<h3>Reference data</h3>');
  });

  it('keeps the things that really are settings', () => {
    const template = settingsTemplate();

    expect(template).toContain('showTransactionsInDetailsChange.emit');
    expect(template).toContain('<h3>Photographs</h3>');
    expect(template).toContain('<h3>Maintenance</h3>');
    expect(template).toContain('previewPmBackfill()');
  });

  it('puts "Show transactions…" and its checkbox on one line', () => {
    /* The owner's second tidy-up. A checkbox on its own row above its own
     * sentence reads as two settings; the inline row is what joins them.
     * Asserted on the markup because there is no layout to measure in a
     * Node test — the class is the only evidence there is, and the
     * stylesheet is checked alongside it so the class is not inert. */
    const template = settingsTemplate();
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');

    expect(template).toContain('settings-row--inline');
    expect(template).toContain('checkbox-label--inline');
    expect(styles).toContain('.settings-row--inline');
    expect(styles).toContain('.checkbox-label--inline');
  });

  it('puts the label BEFORE the control, in that order in the markup', () => {
    /* "Label first, checkbox after it" is an order, and the order lives in
     * the markup rather than in CSS: a `row-reverse` that reads correctly
     * on screen would still hand a screen reader the control before the
     * sentence that names it. */
    const template = settingsTemplate();
    const label = template.indexOf('Show transactions section in details');
    const checkbox = template.indexOf('showTransactionsInDetailsChange.emit');

    expect(label).toBeGreaterThan(-1);
    expect(checkbox).toBeGreaterThan(label);
  });

  it('sets the row direction on the LABEL, which is the element that holds both halves', () => {
    /* THE BUG THIS PINS, and it is why the first attempt at "one line" did
     * not work. styles/_modal.scss styles every bare <label> in every dialog
     * as a stacked form field — `label { display: flex; flex-direction:
     * column }` — and the <label> here is what contains the sentence AND the
     * checkbox. The inline class was on the wrapping <div>, which has one
     * child and therefore nothing to lay out, so the box stayed under the
     * sentence however "inline" the markup claimed to be.
     *
     * Asserted against the shared partial as well, so that this reads as the
     * conflict it is: if someone ever removes the `flex-direction: column`
     * from the partial this test should be revisited, not deleted. */
    const partial = readFileSync(join(__dirname, '../../styles/_modal.scss'), 'utf8');
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');

    expect(partial).toMatch(/label\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(inlineLabelRule(styles)).toMatch(/flex-direction:\s*row/);
  });

  it('undoes the uppercase field-caption treatment the shared partial puts on a label span', () => {
    /* The same partial makes every <span> inside a <label> an uppercase,
     * letter-spaced field caption. On a sentence the user reads, that is the
     * other half of what made the row look like two settings rather than
     * one. */
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');
    expect(inlineLabelRule(styles)).toMatch(/text-transform:\s*none/);
  });
});

/**
 * Just the `.checkbox-label--inline` block.
 *
 * BOUNDED AT BOTH ENDS on purpose: a slice that ran to the end of the file
 * would be satisfied by a `flex-direction: row` belonging to some other
 * control three rules further down, which is exactly the kind of accident
 * that let the broken version of this row pass for a day.
 */
function inlineLabelRule(styles: string): string {
  const start = styles.indexOf('.checkbox-label--inline');
  const end = styles.indexOf('// ---- Photographs ----', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

/* ===================== PHOTOGRAPHS =====================
 *
 * The storage mode is a DATA decision: 'referenced' means the application
 * keeps no copy of the user's photographs at all, so the screen has to say
 * what each mode costs and — above everything else — that changing it does
 * nothing to photographs already imported.
 *
 * The size setting is the owner's "maximum image size allowed", resolved to
 * mean the size of the STORED COPY. These tests pin that reading, because a
 * limit on the files he may pick would reject 46 MB originals the app has
 * always imported happily.
 */
describe('SettingsModal — photographs', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('offers both storage modes and says what each one costs', () => {
    const template = settingsTemplate();

    expect(template).toContain("setImageStorageMode('stored')");
    expect(template).toContain("setImageStorageMode('referenced')");
    // The consequence of 'referenced', in the words a non-technical user
    // needs: their files become the only copy.
    expect(template).toContain('only copy');
  });

  it('says that changing the mode leaves existing photos alone', () => {
    /* THE MOST IMPORTANT SENTENCE ON THE SCREEN. A mode change converts
     * nothing and deletes nothing; a user who believes otherwise either
     * avoids a setting he wants or expects a conversion that never
     * happens. */
    const template = settingsTemplate();

    expect(template).toContain('Photos already imported are left exactly as they are');
    expect(template).toContain('import from now on');
  });

  it('labels the size setting as the STORED size, not the source file', () => {
    const template = settingsTemplate();

    expect(template).toContain('stored in the database');
    // And says outright that the user's own files are untouched, because
    // "maximum image size" otherwise reads as "photos I may not import".
    expect(template).toContain('never changed and are never refused');
  });

  it('starts on the saved values and saves both of them', async () => {
    const { modal, storage } = createModal();
    const asRecord = modal as unknown as Record<string, unknown>;

    // Through the handlers the radios and the box actually call, so this
    // also proves a choice made before the saved values have loaded is not
    // overwritten when they arrive.
    (asRecord['setImageStorageMode'] as (mode: string) => void)('referenced');
    (asRecord['setMaxStoredImageMb'] as (value: string) => void)('0.390625');
    (modal as unknown as { saveSettings(): void }).saveSettings();

    // saveSettings fires its write without awaiting it.
    await vi.waitFor(async () => {
      const saved = await storage.get<AppSettings>(StorageKeys.AppSettings);
      expect(saved?.imageStorageMode).toBe('referenced');
      expect(saved?.maxStoredImageBytes).toBe(400 * 1024);
    });
  });

  it('cannot save a budget over the 10 MB cap', async () => {
    // The owner's number, enforced away from the input element: the box's
    // `max` attribute is advice, not a guarantee.
    const { modal, storage } = createModal();
    const asRecord = modal as unknown as Record<string, unknown>;

    (asRecord['setMaxStoredImageMb'] as (value: string) => void)('500');
    (modal as unknown as { saveSettings(): void }).saveSettings();

    await vi.waitFor(async () => {
      const saved = await storage.get<AppSettings>(StorageKeys.AppSettings);
      expect(saved?.maxStoredImageBytes).toBe(10 * 1024 * 1024);
    });
  });

  it('does not wipe the other preferences when it saves', async () => {
    // StorageKeys.AppSettings is one shared object — the import's base
    // folder lives in it too.
    const { modal, storage } = createModal();
    await storage.set<AppSettings>(StorageKeys.AppSettings, {
      showTransactionsInDetails: false,
      imageImportBaseFolder: 'C:\\Pics'
    });

    (modal as unknown as { saveSettings(): void }).saveSettings();

    await vi.waitFor(async () => {
      const saved = await storage.get<AppSettings>(StorageKeys.AppSettings);
      expect(saved?.imageImportBaseFolder).toBe('C:\\Pics');
      expect(saved?.imageStorageMode).toBe('stored');
    });
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
