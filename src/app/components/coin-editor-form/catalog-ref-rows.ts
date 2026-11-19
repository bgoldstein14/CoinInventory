/* Pure list edits behind the editor's catalogue-reference rows. Each returns a new array. */

import { CatalogOption, CatalogRef } from '../../types/catalog-reference';

/** A row edit from the template; the select supplies `catalogId` as a string. */
export interface CatalogRefRowPatch {
  catalogId?: number | string | null;
  catalogNumber?: string;
}

/** Appends an empty row. */
export function addCatalogRefRow(refs: readonly CatalogRef[] | undefined): CatalogRef[] {
  return [...(refs ?? []), { catalogId: null, catalogNumber: '' }];
}

/** Removes the row at `index`. */
export function removeCatalogRefRow(refs: readonly CatalogRef[] | undefined, index: number): CatalogRef[] {
  return (refs ?? []).filter((_, i) => i !== index);
}

/** Applies `patch` to the row at `index`; '' from the select means no catalogue. */
export function updateCatalogRefRow(
  refs: readonly CatalogRef[] | undefined,
  index: number,
  patch: CatalogRefRowPatch
): CatalogRef[] {
  return (refs ?? []).map((ref, i) => {
    if (i !== index) return ref;
    const next = { ...ref };
    if ('catalogId' in patch) {
      const text = String(patch.catalogId ?? '').trim();
      const id = text === '' ? null : Number(text);
      next.catalogId = id !== null && Number.isFinite(id) ? id : null;
    }
    if (patch.catalogNumber !== undefined) next.catalogNumber = patch.catalogNumber;
    return next;
  });
}

/** One `<option>` in a row's catalogue picker. */
export interface CatalogPickerOption {
  value: string;
  label: string;
}

/**
 * A row's picker options: the active catalogues, plus the row's own catalogue
 * when it has been removed, so the reference still reads e.g. "Cohen (removed)".
 */
export function catalogPickerOptions(
  catalogs: readonly CatalogOption[],
  ref: CatalogRef
): CatalogPickerOption[] {
  const options = catalogs
    .filter(catalog => catalog.isActive)
    .map(catalog => ({ value: String(catalog.catalogId), label: catalog.name }));
  const current = catalogs.find(catalog => Number(catalog.catalogId) === Number(ref.catalogId));
  if (ref.catalogId !== null && current && !current.isActive) {
    options.push({ value: String(current.catalogId), label: `${current.name} (removed)` });
  }
  return options;
}
