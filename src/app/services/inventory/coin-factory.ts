import { CoinRecord } from '../../types/coin.model';

/* ===========================================================================
 * Coin factory
 * ---------------------------------------------------------------------------
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
 * =========================================================================== */

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
    pmPercent: undefined
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
 * ---------------------------------------------------------------------------
 * OLD EXPORTS THAT STILL CARRY A `tags` ARRAY
 * ---------------------------------------------------------------------------
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
 */
export function normalizeImportedCoins(parsed: CoinRecord[]): CoinRecord[] {
  return parsed.map(coin => ({
    ...coin,
    id: coin.id || crypto.randomUUID(),
    imagePaths: Array.isArray(coin.imagePaths) ? coin.imagePaths : [],
    source: coin.source || 'manual',
    grade: coin.grade || '',
    category: coin.category || '',
    hasCacSticker: Boolean(coin.hasCacSticker)
  }));
}
