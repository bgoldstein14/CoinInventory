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

/** Creates the modal inside an injection context, since it uses inject(). */
function createModal(apiOverrides: Record<string, unknown> = {}) {
  const { inv, storage, mockApiService } = createTestInventoryService();

  // The backup panel calls ApiService directly. getBackupSuggestion runs in
  // the constructor, so every test needs at least that stub.
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

  // Required input; built without TestBed, so stub it or saveSettings() throws.
  (modal as unknown as Record<string, unknown>)['showTransactionsInDetails'] = () => false;

  return { modal, inv, storage, mockApiService, api };
}

/* ---- Backup panel fixtures ---- */

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

/** The template with comments stripped, so assertions only see markup. */
function settingsTemplate(): string {
  return readFileSync(join(__dirname, 'settings-modal.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

describe('SettingsModal — settings, and nothing else', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  // Reference lists are edited on the Reference Data screen (see category-modal.spec.ts).

  it('cannot edit any reference list any more', () => {
    const { modal } = createModal();
    const asRecord = modal as unknown as Record<string, unknown>;

    for (const gone of [
      'addCategory', 'removeCategory', 'categoryDraft',
      'addMintMark', 'removeMintMarkEntry', 'mintMarkDraft',
      'addMetalContent', 'removeMetalContent', 'metalContentDraft',
      'addCoinSet', 'removeCoinSet', 'coinSetDraft',
      'addDenomination', 'removeDenominationEntry', 'denominationDraft',
    ]) {
      expect(asRecord[gone], `${gone} is still on SettingsModal`).toBeUndefined();
    }

    expect(typeof asRecord['saveSettings']).toBe('function');
    expect(typeof asRecord['previewPmBackfill']).toBe('function');
  });

  it('has no reference-list markup left in the template', () => {
    const template = settingsTemplate();

    expect(template).not.toContain('Reference lists');
    expect(template).not.toContain('settings-chip-list');
    expect(template).not.toContain('settings-inline-add');
    expect(template).not.toContain('chip-button');
    expect(template).not.toContain('categoryDraft');
    expect(template).not.toContain('mintMarkDraft');
    expect(template).not.toContain('metalContentDraft');
    expect(template).not.toContain('coinSetDraft');
    expect(template).not.toContain('inv.denominations()');
  });

  it('does NOT signpost Reference Data any more', () => {
    // The toolbar already has a Reference Data button.
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
    // No layout in a Node test, so check the class exists in both markup and styles.
    const template = settingsTemplate();
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');

    expect(template).toContain('settings-row--inline');
    expect(template).toContain('checkbox-label--inline');
    expect(styles).toContain('.settings-row--inline');
    expect(styles).toContain('.checkbox-label--inline');
  });

  it('puts the label BEFORE the control, in that order in the markup', () => {
    // Order must be in the markup, not CSS, so screen readers read the label first.
    const template = settingsTemplate();
    const label = template.indexOf('Show transactions section in details');
    const checkbox = template.indexOf('showTransactionsInDetailsChange.emit');

    expect(label).toBeGreaterThan(-1);
    expect(checkbox).toBeGreaterThan(label);
  });

  it('sets the row direction on the LABEL, which is the element that holds both halves', () => {
    // styles/_modal.scss stacks every <label> as a column; the inline rule
    // must override that on the label itself, not on a wrapper.
    const partial = readFileSync(join(__dirname, '../../styles/_modal.scss'), 'utf8');
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');

    expect(partial).toMatch(/label\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(inlineLabelRule(styles)).toMatch(/flex-direction:\s*row/);
  });

  it('undoes the uppercase field-caption treatment the shared partial puts on a label span', () => {
    // The shared partial uppercases every <span> inside a <label>.
    const styles = readFileSync(join(__dirname, 'settings-modal.scss'), 'utf8');
    expect(inlineLabelRule(styles)).toMatch(/text-transform:\s*none/);
  });
});

/**
 * Just the `.checkbox-label--inline` block, bounded at both ends so a later
 * rule cannot satisfy the assertion.
 */
function inlineLabelRule(styles: string): string {
  const start = styles.indexOf('.checkbox-label--inline');
  const end = styles.indexOf('// ---- Photographs ----', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

/* ---- Photographs ----
 * The size setting limits the stored copy, not the source file.
 */
describe('SettingsModal — photographs', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('offers both storage modes and says what each one costs', () => {
    const template = settingsTemplate();

    expect(template).toContain("setImageStorageMode('stored')");
    expect(template).toContain("setImageStorageMode('referenced')");
    expect(template).toContain('only copy');
  });

  it('says that changing the mode leaves existing photos alone', () => {
    const template = settingsTemplate();

    expect(template).toContain('Photos already imported are left exactly as they are');
    expect(template).toContain('import from now on');
  });

  it('labels the size setting as the STORED size, not the source file', () => {
    const template = settingsTemplate();

    expect(template).toContain('stored in the database');
    expect(template).toContain('never changed and are never refused');
  });

  it('starts on the saved values and saves both of them', async () => {
    const { modal, storage } = createModal();
    const asRecord = modal as unknown as Record<string, unknown>;

    // Uses the real handlers, so a choice made before load is not overwritten.
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
    // The input's `max` attribute is not enforced, so the component clamps.
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
    // AppSettings is one shared object; other features store keys in it too.
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

/* ---- Maintenance: precious-metal backfill ----
 * Planner rules are in services/pm-backfill.spec.ts; these cover the wiring
 * to InventoryService and the payloads sent.
 */

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
      // Already complete: all five fields present, including gross weight.
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
    expect(new Set(ids).size).toBe(ids.length);

    const outcome = modal['backfillOutcome']();
    expect(outcome?.filled).toBe(promised);
    expect(outcome?.failed).toBe(0);
  });

  it('sends ONLY precious-metal fields in each payload', async () => {
    // PUT /api/coins/:id writes every field it receives, so a full record
    // would overwrite unrelated columns.
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
      // Gross weight, not the gold weight above.
      weight: 33.436
    });
    expect(saint).not.toHaveProperty('notes');
    expect(saint).not.toHaveProperty('purchasePrice');
  });

  it('never re-sends a field the coin already had', async () => {
    // The Kennedy half already has metalContent; it must not be in the payload.
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
    // The melt column reads the live inventory signal.
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
