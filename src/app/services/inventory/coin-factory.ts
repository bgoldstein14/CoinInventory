import { CoinRecord } from '../../types/coin.model';
import { normalizeCollectionStatus } from '../../types/collection-status';
// The ONE resolver, shared with the editor's picker, the QIF importer, the
// CSV/Excel importer and (transcribed into T-SQL) migration 014.
import {
  resolveDenominationId,
  type IndexableDenomination
} from '../denominations/denomination-index';

 /*
 * Coin factory
 *
 * WHAT THIS FILE OWNS
 *   The two places where a CoinRecord object is created from scratch:
 *     * `createBlankCoin()`      — the empty row the "Add coin" button makes,
 *     * `normalizeImportedCoins()` — filling in the blanks on records that
 *       arrived from a JSON export (which may be old, hand-edited, or partial).
 *
 * WHY IT IS ITS OWN FILE
 *   These are long literal objects with no logic in them. Parked here, the
 *   store that uses them stays about *what happens to* coins rather than
 *   *what a coin looks like*, and there is exactly one place to visit when a
 *   new field is added to CoinRecord.
  */

/**
 * A brand-new, completely empty coin, ready for the user to fill in.
 *
 * Every field is initialised explicitly (rather than left `undefined`) so the
 * record we POST to the server is complete and the confirmed-state snapshot
 * has something to diff against later.
 */
export function createBlankCoin(): CoinRecord {
  return {
    id: crypto.randomUUID(),
    denomination: '',
    /* No denomination means no link, and that is written down rather than
     * left undefined for the same reason every other field here is: the
     * record is POSTed as-is and is the snapshot later edits diff against.
     * There is nothing to resolve -- a blank coin is not an import and has
     * no source text to interpret. The editor's picker writes BOTH fields
     * the moment the user chooses something. */
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
    // A coin the user has just pressed "Add coin" for is a coin he has. The
    // want list is reached by changing this afterwards, not by making him
    // declare ownership of every coin he types in.
    collectionStatus: 'owned',
    // Empty string rather than undefined, like every other text field above:
    // the record is POSTed as-is and is the snapshot later edits diff against.
    storageLocation: ''
  };
}

/**
 * Repair records coming from an inventory JSON import.
 *
 * Imported files are not trusted: an id may be missing, `imagePaths` may be
 * absent or the wrong type, and text fields may be null. Each coin is copied
 * with those specific gaps filled so the rest of the app can assume a
 * well-formed CoinRecord.
 *
 * ---- OLD EXPORTS THAT STILL CARRY A `tags` ARRAY ----
 * Coins used to have a `tags: string[]` field. It was removed because nothing
 * in the app could ever put a value in it. Any JSON file the user exported
 * BEFORE that removal still has `"tags": []` (or, in principle, a populated
 * array) on every coin, and those files must keep importing.
 *
 * They do, and the reason is worth spelling out because it is easy to break by
 * accident. The `...coin` spread below copies whatever keys the file happened
 * to contain, and then the explicit properties overwrite the handful we care
 * about. A stray `tags` key therefore rides along as an extra property on the
 * object: TypeScript never sees it (the value arrives as parsed JSON at
 * runtime, not as a checked literal), nothing reads it, and no validation step
 * rejects unknown keys. It is inert.
 *
 * What would break that: switching this function to build a NEW object from an
 * explicit list of fields and then adding a schema check that rejects unknown
 * keys. If you ever do the second half of that, make `tags` an explicitly
 * ignored key rather than an error — importing an old backup must not fail.
 *
 * The regression test for exactly this lives in coin-factory.spec.ts.
 *
 * ---- THE DENOMINATION LINK                                        (design §4.1) ----
 * A JSON restore is an import like any other, so it gets the same treatment
 * as the QIF and spreadsheet paths: the text the file gave is written
 * untouched, and `denominationId` is filled in where the text names exactly
 * one row. No link is an ordinary outcome, not an error — the coin reads
 * `Other (8 Reales)` and keeps the only record of what the file said.
 *
 * *** AN ID ALREADY IN THE FILE IS NEVER OVERWRITTEN. *** It came out of a
 * database the user had already curated, and it is allowed to disagree with
 * the text: a coin whose text says `Pillar Dollar` and whose id says
 * `8 Reales` is in the normal post-import state. Re-resolving on restore
 * would quietly re-file such coins — or unfile them, since `Pillar Dollar`
 * resolves to nothing — every time a backup was opened.
 *
 * @param denominations the lookup list. OPTIONAL: a restore that happens
 *   before `GET /api/denominations` has answered links nothing and still
 *   restores every coin, which is the right trade. The id is recoverable
 *   from the text later; the coins are not recoverable at all.
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
    hasCacSticker: Boolean(coin.hasCacSticker),
    // EVERY BACKUP TAKEN BEFORE MIGRATION 010 IS MISSING THIS FIELD.
    //
    // That is the overwhelmingly common case, not an edge one, and if those
    // coins came back as anything other than Owned they would restore into a
    // collection whose totals and insurance schedule silently ignored them —
    // every coin present and correct in the grid, every figure wrong.
    //
    // normalizeCollectionStatus() answers 'owned' for absent, null, empty and
    // unrecognised alike, so one call covers the old backup, the hand-edited
    // file and the file written by a future build at once.
    //
    // `storageLocation` deliberately gets no line here. It is free text with
    // no default: a backup that has none genuinely has none, and writing ''
    // over it would be inventing data rather than repairing it.
    collectionStatus: normalizeCollectionStatus(coin.collectionStatus),
     /*
     * `??` AND NOT `||`, AND THAT IS THE WHOLE BEHAVIOUR.
     *
     * An id the file carried wins — see the note above. `??` passes through
     * only null and undefined, which are exactly "this backup has no link",
     * so a resolution happens for those coins and only those.
     *
     * The coin's OWN country is passed, never a constant: it scopes the
     * search before it widens, so a restored Australian penny finds the
     * Australian row and a US one correctly finds none.
      */
    denominationId: coin.denominationId
      ?? resolveDenominationId(coin.denomination, coin.country, denominations)
    };

     /*
     * `imagePaths` IS REMOVED WHEN THE FILE DOES NOT CARRY A REAL ARRAY.
     *
     * It used to be coerced to `[]`, and that stopped being safe when the
     * list endpoint stopped sending photographs — because the JSON export is
     * taken from those same in-memory records and therefore no longer
     * contains any (see features/inventory/inventory-file-io.ts).
     *
     * `[]` would make every imported coin CLAIM to have no photographs about
     * a database row that has eight. The claim is not inert: the gallery's
     * add / delete / re-order all send the COMPLETE array, and
     * `PUT /api/coins/:id` re-inserts exactly what it is given — so the
     * first photo attached to such a coin would delete the other eight.
     *
     * Absent means "not loaded", which is the truth, and the hydrator
     * fetches the real set the moment the coin is selected.
     *
     * A file that DOES carry a real array keeps it, including an empty one:
     * that is a genuine "this coin has no photographs" from an export taken
     * while they were still included.
      */
    if (!Array.isArray(coin.imagePaths)) delete normalized.imagePaths;

    return normalized;
  });
}
