import 'fake-indexeddb/auto';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { createTestInventoryService } from '../../testing/test-helpers';
import { addCatalogRefRow, catalogPickerOptions, removeCatalogRefRow, updateCatalogRefRow } from './catalog-ref-rows';

const SEAR = { catalogId: 1, catalogNumber: '6819' };
const RIC = { catalogId: 2, catalogNumber: '123' };

describe('editing the reference rows', () => {
  it('adds an empty row at the end', () => {
    expect(addCatalogRefRow([SEAR])).toEqual([SEAR, { catalogId: null, catalogNumber: '' }]);
    expect(addCatalogRefRow(undefined)).toEqual([{ catalogId: null, catalogNumber: '' }]);
  });

  it('removes a row by position', () => {
    expect(removeCatalogRefRow([SEAR, RIC], 0)).toEqual([RIC]);
    expect(removeCatalogRefRow([SEAR], 0)).toEqual([]);
  });

  it('updates one row and leaves the others', () => {
    expect(updateCatalogRefRow([SEAR, RIC], 1, { catalogNumber: '124' })).toEqual([SEAR, { catalogId: 2, catalogNumber: '124' }]);
  });

  it('reads the catalogue select value: "" is no catalogue, otherwise a number', () => {
    expect(updateCatalogRefRow([SEAR], 0, { catalogId: '' })).toEqual([{ catalogId: null, catalogNumber: '6819' }]);
    expect(updateCatalogRefRow([SEAR], 0, { catalogId: '2' })).toEqual([{ catalogId: 2, catalogNumber: '6819' }]);
  });

  it('never changes the list it was given', () => {
    const refs = [SEAR];
    removeCatalogRefRow(refs, 0);
    updateCatalogRefRow(refs, 0, { catalogNumber: 'x' });
    expect(refs).toEqual([SEAR]);
  });
});

describe('saving references', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness() {
    const h = createTestInventoryService();
    h.inv.inventory.set([{ id: 'coin-1', denomination: 'Denarius', catalogRefs: [SEAR, RIC] } as unknown as CoinRecord]);
    return h;
  }

  it('sends the whole list when one reference changes', () => {
    const { inv, mockApiService } = harness();
    inv.updateCoin('coin-1', { catalogRefs: [SEAR] });
    vi.advanceTimersByTime(1500);
    const body = (mockApiService.updateCoin as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body).toEqual({ catalogRefs: [SEAR] });
  });

  it('sends an empty list when the last reference is removed, so it really clears', () => {
    const { inv, mockApiService } = harness();
    inv.updateCoin('coin-1', { catalogRefs: [] });
    vi.advanceTimersByTime(1500);
    const body = (mockApiService.updateCoin as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body).toEqual({ catalogRefs: [] });
  });
});

describe('the reference rows in the template', () => {
  const template = readFileSync(join(__dirname, 'coin-editor-form.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

  it('builds each row\'s options with catalogOptionsFor', () => {
    expect(template).toContain('@for (option of catalogOptionsFor(ref); track option.value)');
  });

  it('caps each number at the column width', () => {
    expect(template).toContain('[attr.maxlength]="CATALOG_NUMBER_MAX_LENGTH"');
  });

  it('has one row per reference with add and remove buttons', () => {
    expect(template).toMatch(/@for \(ref of catalogRefs\(\); track \$index\)/);
    expect(template).toContain('(click)="addCatalogRef()"');
    expect(template).toContain('(click)="removeCatalogRef($index)"');
  });
});

describe('the catalogue picker for one row', () => {
  const all = [
    { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
    { catalogId: 10, name: 'Cohen', sortOrder: 10, isActive: false }
  ];

  it('offers the active catalogues', () => {
    expect(catalogPickerOptions(all, SEAR).map(o => o.label)).toEqual(['Sear']);
  });

  it('also shows a removed catalogue the row already uses, marked as removed', () => {
    const options = catalogPickerOptions(all, { catalogId: 10, catalogNumber: '45' });
    expect(options).toEqual([
      { value: '1', label: 'Sear' },
      { value: '10', label: 'Cohen (removed)' }
    ]);
  });
});
