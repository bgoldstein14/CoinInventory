import { normalizeCollectionStatus } from './collection-status';

/**
 * db/row-mappers.ts — turning SQL Server rows into the JSON the Angular app
 * expects.
 *
 * SQL Server hands us CamelCase column names (CoinId, PurchaseDate, ...) while
 * the frontend works in camelCase (id, purchaseDate, ...). Everything that
 * performs that translation lives here, so if the frontend ever needs a new
 * field there is exactly one place to add it.
 */

/** A Coins row, as the Angular app expects it. */
export function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['CoinId'],
    denomination: row['Denomination'] ?? '',
    // The canonical denomination link, returned ALONGSIDE the text above.
    // Both, always, and they are allowed to disagree: the id is what the
    // denomination turned out to be and the text is what the source said.
    //
    // *** `?? null`, NOT `?? undefined` LIKE catalogId AND coinSet BELOW. ***
    // Those use undefined so JSON.stringify drops the key and the client can
    // tell "never recorded" from "recorded as blank". No such distinction
    // exists here: "no link" is ONE state, it is the NORMAL state of an
    // imported coin, and it is what the editor renders as unresolved. If both
    // a missing key and a null could mean it, the first consumer to test only
    // one would show an unresolved coin as though it were linked.
    //
    // It also covers a database migration 011 has not reached, where the
    // column does not exist and the row has no such key.
    denominationId: row['DenominationId'] ?? null,
    year: row['Year'] ?? '',
    coinType: row['CoinType'] ?? '',
    category: row['Category'] ?? '',
    country: row['Country'] ?? '',
    grade: row['Grade'] ?? '',
    certCompany: row['CertCompany'] ?? '',
    certNumber: row['CertNumber'] ?? '',
    variety: row['Variety'] ?? '',
    mintMark: row['MintMark'] ?? '',
    composition: row['Composition'] ?? '',
    purchaseDate: row['PurchaseDate'] ?? '',
    purchasePrice: row['PurchasePrice'] ?? 0,
    currentValue: row['CurrentValue'] ?? 0,
    notes: row['Notes'] ?? '',
    source: row['Source'] ?? 'manual',
    hasCacSticker: row['HasCacSticker'] === true || row['HasCacSticker'] === 1,
    soldPrice: row['SoldPrice'] ?? undefined,
    soldDate: row['SoldDate'] ?? undefined,
    // Gross weight, in GRAMS (troy ounces before migration 008) — the same
    // unit as pmWeightGrams below.
    weight: row['Weight'] ?? undefined,
    metalContent: row['MetalContent'] ?? undefined,
    pmWeightGrams: row['PmWeightGrams'] ?? undefined,
    pmPercent: row['PmPercent'] ?? undefined,
    coinSet: row['CoinSet'] ?? undefined,
    // *** NEVER `row['CollectionStatus'] ?? undefined` LIKE THE LINES ABOVE. ***
    //
    // Until migration 010 has been run, EVERY row in the live database has no
    // CollectionStatus at all, and after it is added by an older INSERT path
    // it can still arrive NULL. Passing that through would hand the Angular
    // app a whole collection whose status is unknown — and the client treats
    // unknown as owned, so it would LOOK right, right up until something
    // compared the raw value instead of normalising it.
    //
    // Answering here, once, means the API's contract is "always one of the
    // five tokens" rather than "one of the five, or null, or missing". That
    // is one less thing every consumer has to remember. An unrecognised value
    // (hand-edited data, a row from a newer build) also becomes 'owned'
    // rather than being passed on: taking a coin out of the user's collection
    // over a word nobody recognises is the wrong trade.
    collectionStatus: normalizeCollectionStatus(row['CollectionStatus']),
    // Ordinary optional text, exactly like coinSet above: a NULL becomes
    // undefined so JSON.stringify drops the key and the client can tell
    // "never recorded" from "recorded as blank". Nothing normalises it --
    // see the note on the binding in coin-fields.ts.
    storageLocation: row['StorageLocation'] ?? undefined,
    // The catalogue reference, in two parts. `?? undefined` for both, like
    // coinSet and storageLocation above, so JSON.stringify drops the key and
    // the client can tell "never recorded" from "recorded as blank". It also
    // covers a database migration 012 has not reached, where these columns do
    // not exist.
    //
    // NOT `?? 0` and NOT `?? ''`: the column is IDENTITY so ids start at 1,
    // and a 0 would read as "attributed" to anything checking for a value
    // rather than for undefined.
    //
    // Nothing is joined or resolved here. The NAME behind CatalogId is looked
    // up on the client from the lookup list it already holds
    // (catalogNameById() in src/app/types/catalog-reference.ts). A join would
    // put a second, staler copy of that name on the wire: the editor writes
    // the id and re-renders immediately, long before a reload could bring a
    // joined name back.
    catalogId: row['CatalogId'] ?? undefined,
    catalogNumber: row['CatalogNumber'] ?? undefined,
  };
}

/** YYYY-MM-DD. SQL Server returns Date objects; JSON responses want text. */
export function formatDate(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}
