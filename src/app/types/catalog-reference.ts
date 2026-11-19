/*
 * A coin's catalogue reference ("Sear 6819"): the Catalogs lookup type, the
 * seed list, and the functions that turn (catalogId, catalogNumber) into
 * display text. All display of a reference goes through these.
 *
 * No lookup is performed: entering a reference fills in nothing else, since
 * most of these catalogues have no queryable source.
 *
 * Imports nothing (not even CoinRecord) so it cannot join an import cycle with
 * inventory-columns.ts and the other callers.
 */

/** One row of the Catalogs lookup table, as `GET /api/catalogs` returns it. */
export interface CatalogOption {
  /** Catalogs.CatalogId -- the value stored in CoinCatalogRefs.CatalogId. */
  catalogId: number;
  /** Catalogs.Name NVARCHAR(60) -- 'Sear', 'RIC', 'Krause (KM)'. */
  name: string;
  /** Display order in the picker. Seeded 1..15; user additions go on the end. */
  sortOrder: number;
  /** False once removed: hidden from the picker but still named in the grid. */
  isActive: boolean;
}

/** One of a coin's catalogue references. `catalogId` is null when no catalogue was chosen. */
export interface CatalogRef {
  catalogId: number | null;
  catalogNumber: string;
}

/** Column widths of Catalogs.Name and CoinCatalogRefs.CatalogNumber; inputs are capped to these. */
export const CATALOG_NAME_MAX_LENGTH = 60;
export const CATALOG_NUMBER_MAX_LENGTH = 50;

/**
 * Catalogues a fresh database is seeded with, in SortOrder.
 *
 * The first fourteen expand `CATALOG_PREFIXES` from
 * services/image-matching/filename-vocabulary.ts, in the same order
 * (catalog-reference.spec.ts checks this). Krause (KM) is added last for world
 * coins. The maintenance screen can add, rename and remove entries.
 */
export const CATALOG_SEED: readonly string[] = [
  'Sear',       // David Sear -- Greek / Roman / Byzantine
  'RIC',        // Roman Imperial Coinage
  'Hendin',     // Guide to Biblical Coins (Judaea)
  'RPC',        // Roman Provincial Coinage
  'Svoronos',   // Ptolemaic
  'BMC',        // British Museum Catalogue
  'SNG',        // Sylloge Nummorum Graecorum
  'Crawford',   // Roman Republican Coinage (RRC)
  'Sydenham',   // The Coinage of the Roman Republic
  'Cohen',      // Description historique des monnaies ... romaines
  'RSC',        // Roman Silver Coinage
  'Meshorer',   // Ancient Jewish Coinage
  'TJC',        // A Treasury of Jewish Coins
  'Kraay',      // Archaic and Classical Greek Coins
  'Krause (KM)' // Standard Catalog of World Coins (not from the matcher list)
];

/**
 * The catalogue's display name for an id, or '' when unknown (callers then
 * show the number alone).
 *
 * The id is compared via Number() because CSV round-trips can supply it as a
 * string. Inactive (soft-deleted) catalogues still resolve so existing coins
 * keep their reference.
 */
export function catalogNameById(
  catalogs: readonly CatalogOption[] | undefined,
  catalogId: number | null | undefined
): string {
  if (catalogId === null || catalogId === undefined) return '';
  // A CSV round-trip can supply '' here, and Number('') is 0, which would be looked up as an id.
  if (String(catalogId).trim() === '') return '';
  if (!catalogs || catalogs.length === 0) return '';

  const wanted = Number(catalogId);
  if (!Number.isFinite(wanted)) return '';

  return catalogs.find(catalog => Number(catalog.catalogId) === wanted)?.name ?? '';
}

/**
 * The reference as written, e.g. `Sear 6819`. Either part may be missing
 * ('Sear', '6819', or ''). Only outer whitespace is trimmed; formats like
 * `RRC 44/5` are kept exactly as typed.
 */
export function formatCatalogReference(
  catalogName: string | null | undefined,
  catalogNumber: string | null | undefined
): string {
  const name = (catalogName ?? '').trim();
  const number = (catalogNumber ?? '').trim();

  if (name && number) return `${name} ${number}`;
  return name || number;
}

/**
 * Resolve the id and format the reference. Used by the grid, search and editor
 * so they always agree.
 */
export function coinCatalogReference(
  catalogs: readonly CatalogOption[] | undefined,
  catalogId: number | null | undefined,
  catalogNumber: string | null | undefined
): string {
  return formatCatalogReference(catalogNameById(catalogs, catalogId), catalogNumber);
}

const MAIN_CATALOG_NAME = 'sear';

/** The reference shown where one value is needed: the first Sear reference, else the first. */
export function mainCatalogRef(
  catalogs: readonly CatalogOption[] | undefined,
  refs: readonly CatalogRef[] | undefined
): CatalogRef | null {
  if (!refs || refs.length === 0) return null;
  const sear = refs.find(
    ref => catalogNameById(catalogs, ref.catalogId).trim().toLowerCase() === MAIN_CATALOG_NAME
  );
  return sear ?? refs[0];
}

/** The main reference as text, e.g. `Sear 6819`; '' when none. Used for sorting and grouping. */
export function mainCatalogRefLabel(
  catalogs: readonly CatalogOption[] | undefined,
  refs: readonly CatalogRef[] | undefined
): string {
  const main = mainCatalogRef(catalogs, normalizeCatalogRefs(refs));
  return main ? coinCatalogReference(catalogs, main.catalogId, main.catalogNumber) : '';
}

/**
 * The main reference plus a count of the others, e.g. `Sear 6819 (+2)`; '' when
 * none. Rows without a number (an unsaved new row) and duplicates are not counted.
 */
export function formatMainCatalogRef(
  catalogs: readonly CatalogOption[] | undefined,
  refs: readonly CatalogRef[] | undefined
): string {
  const saved = normalizeCatalogRefs(refs);
  const text = mainCatalogRefLabel(catalogs, saved);
  if (!text) return '';
  const others = saved.length - 1;
  return others > 0 ? `${text} (+${others})` : text;
}

/** Every reference, in order, joined with "; " (also the CSV export format). */
export function formatCatalogRefs(
  catalogs: readonly CatalogOption[] | undefined,
  refs: readonly CatalogRef[] | undefined
): string {
  return (refs ?? [])
    .map(ref => coinCatalogReference(catalogs, ref.catalogId, ref.catalogNumber))
    .filter(Boolean)
    .join('; ');
}

/** Trim numbers, drop references without a number, and drop exact duplicates, keeping order. */
export function normalizeCatalogRefs(refs: readonly CatalogRef[] | undefined): CatalogRef[] {
  const seen = new Set<string>();
  const result: CatalogRef[] = [];
  for (const ref of refs ?? []) {
    const catalogNumber = (ref.catalogNumber ?? '').trim();
    if (!catalogNumber) continue;
    const id = ref.catalogId === null || ref.catalogId === undefined || String(ref.catalogId).trim() === ''
      ? null
      : Number(ref.catalogId);
    const catalogId = id !== null && Number.isFinite(id) ? id : null;
    const key = `${catalogId ?? ''}|${catalogNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ catalogId, catalogNumber });
  }
  return result;
}

/**
 * Read references from text such as `Sear 6819; RIC 123` (the CSV format).
 * Each part starting with a known catalogue name and followed by a number takes
 * that catalogue (longest name first; active before removed); any other part,
 * including a bare name, is kept whole as a number.
 */
export function parseCatalogRefs(text: string, catalogs: readonly CatalogOption[]): CatalogRef[] {
  const byLength = [...catalogs]
    .map(catalog => ({ catalog, name: catalog.name.trim().toLowerCase() }))
    .filter(entry => entry.name)
    // Longest name first; on a tie, an active catalogue beats a removed one.
    .sort((a, b) => b.name.length - a.name.length || Number(b.catalog.isActive) - Number(a.catalog.isActive));

  const refs = (text ?? '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const lower = part.toLowerCase();
    const hit = byLength.find(({ name }) =>
      lower.startsWith(name) && (lower.length === name.length || /\s/.test(lower[name.length]))
    );
    const number = hit ? part.slice(hit.name.length).trim() : '';
    // A bare catalogue name (no number) is kept as text rather than dropped.
    return hit && number
      ? { catalogId: hit.catalog.catalogId, catalogNumber: number }
      : { catalogId: null, catalogNumber: part };
  });
  return normalizeCatalogRefs(refs);
}
