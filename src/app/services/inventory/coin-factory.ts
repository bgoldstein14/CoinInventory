import { CoinRecord } from '../../types/coin.model';
import { normalizeCollectionStatus } from '../../types/collection-status';
import { normalizeCatalogRefs } from '../../types/catalog-reference';
import { cacStickerFor } from '../../types/cac-sticker';
// The shared denomination resolver (editor, importers, migration 014).
import {
  resolveDenominationId,
  type IndexableDenomination
} from '../denominations/denomination-index';

 /*
  * Builds CoinRecords from scratch: `createBlankCoin()` for "Add coin", and
  * `normalizeImportedCoins()` to fill gaps in records from a JSON export. The one
  * place to update when CoinRecord gains a field.
  */

/**
 * A new, empty coin. Every field is set explicitly (not left undefined) so the
 * POSTed record is complete and the confirmed snapshot has something to diff against.
 */
export function createBlankCoin(): CoinRecord {
  return {
    id: crypto.randomUUID(),
    denomination: '',
    /* No link: nothing to resolve on a blank coin. The editor's picker writes both
     * denomination fields when the user chooses. */
    denominationId: null,
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
    hasCacSticker: false,
    pmWeightGrams: undefined,
    pmPercent: undefined,
    // A new coin is one the user owns; the want list is chosen later by changing this.
    collectionStatus: 'owned',
    // '' rather than undefined, like the other text fields.
    storageLocation: ''
  };
}

/**
 * Repairs records from an inventory JSON import, which isn't trusted: ids may be
 * missing, `imagePaths` absent or the wrong type, text fields null.
 *
 * Old exports may still carry a removed `tags` array. The `...coin` spread keeps
 * unknown keys as inert extra properties, so these files still import. If a
 * schema check rejecting unknown keys is ever added, ignore `tags` rather than
 * fail (tested in coin-factory.spec.ts).
 *
 * Denomination link (design §4.1): the text is written untouched and
 * `denominationId` is filled where the text names exactly one row; no link is a
 * normal outcome. An id already in the file is never overwritten: it may
 * legitimately disagree with the text, and re-resolving would re-file coins on
 * every restore.
 *
 * @param denominations optional lookup list; without it nothing links but every
 *   coin still restores
 */
export function normalizeImportedCoins(
  parsed: CoinRecord[],
  denominations: readonly IndexableDenomination[] = []
): CoinRecord[] {
  return parsed.map(coin => {
    const normalized: CoinRecord = {
    ...coin,
    id: coin.id || crypto.randomUUID(),
    source: coin.source || 'manual',
    grade: coin.grade || '',
    category: coin.category || '',
    // CAC only applies to a graded coin.
    hasCacSticker: cacStickerFor(coin.grade, coin.hasCacSticker),
    // Backups from before migration 010 lack this field; normalizeCollectionStatus()
    // returns 'owned' for absent, null, empty or unknown values, so those coins
    // still count in totals. `storageLocation` gets no default: absent means none.
    collectionStatus: normalizeCollectionStatus(coin.collectionStatus),
     /*
      * `??`, not `||`: an id from the file wins; only null/undefined get resolved.
      * The coin's own country is passed, since it scopes the search.
      */
    denominationId: coin.denominationId
      ?? resolveDenominationId(coin.denomination, coin.country, denominations)
    };

     /*
      * `imagePaths` is removed when the file has no real array. Exports no longer
      * include photos (see features/inventory/inventory-file-io.ts), and `[]` would
      * claim the coin has none; since a PUT replaces the whole image set, the next
      * photo attached would delete the rest. Absent means "not loaded", and the
      * hydrator fetches the real set on selection. A real array (even empty) is kept.
      */
    if (!Array.isArray(coin.imagePaths)) delete normalized.imagePaths;

    // Older exports carry one reference as catalogId / catalogNumber.
    const legacy = normalized as CoinRecord & { catalogId?: unknown; catalogNumber?: unknown };
    if (!Array.isArray(coin.catalogRefs) && ('catalogId' in legacy || 'catalogNumber' in legacy)) {
      const refs = normalizeCatalogRefs([{
        catalogId: (legacy.catalogId ?? null) as number | null,
        catalogNumber: String(legacy.catalogNumber ?? '')
      }]);
      if (refs.length > 0) normalized.catalogRefs = refs;
    }
    delete legacy.catalogId;
    delete legacy.catalogNumber;

    return normalized;
  });
}
