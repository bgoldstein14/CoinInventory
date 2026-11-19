import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { createTestInventoryService } from '../../testing/test-helpers';
import { CatalogOption, catalogNameById } from '../../types/catalog-reference';

const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 2, name: 'Cohen', sortOrder: 2, isActive: true }
];

describe('removing a catalogue', () => {
  it('keeps it in the list as inactive, so coins using it keep its name', async () => {
    const { inv, mockApiService } = createTestInventoryService();
    (mockApiService.getCatalogs as ReturnType<typeof vi.fn>).mockReturnValue(of(CATALOGS));
    await inv.loadCatalogs();

    await inv.removeCatalog(2);

    expect(inv.catalogs()).toEqual([
      CATALOGS[0],
      { ...CATALOGS[1], isActive: false }
    ]);
    expect(catalogNameById(inv.catalogs(), 2)).toBe('Cohen');
    expect(inv.activeCatalogs().map(c => c.name)).toEqual(['Sear']);
  });
});
