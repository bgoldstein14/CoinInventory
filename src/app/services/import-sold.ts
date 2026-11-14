/*
 * import-sold.ts — "has this record been sold?", for the import filter.
 *
 * ---- ONE SENTENCE, THREE IMPORT PATHS ----
 * Every importer (QIF, CSV, Excel) offers the same tick box, and it has to
 * mean the same thing on all three or the option is a different feature
 * depending on which menu entry you clicked. The sentence is:
 *
 *     A record counts as SOLD when it has a sold date, a sold price or a
 *     buyer.
 *
 * Any ONE of the three is enough, because somebody entering a spreadsheet
 * from memory may well remember only one of them: the month he let it go,
 * roughly what he got, or who took it. Requiring all three — or requiring
 * the date alone, which is where this started — would silently file those
 * rows as still owned and hand them back in an import the user asked to be
 * free of sold coins.
 *
 * ---- THE THREE FIELDS ARE NOT TESTED THE SAME WAY, AND THAT IS THE BUG ----
 * `if (coin.soldPrice || coin.soldDate || coin.soldTo)` is wrong twice over,
 * and both halves survive a casual read:
 *
 *   SOLD PRICE IS A NUMBER, AND **0 IS A REAL PRICE**. A coin given away,
 *   written off, or traded at no cash value sold for zero. Truthiness reads
 *   that as "never sold" and the record comes back in an import the user
 *   asked to exclude it from. So the price is tested for PRESENCE — is there
 *   a number here at all — and never for magnitude.
 *
 *   SOLD DATE AND SOLD TO ARE TEXT, AND **"   " IS NOT A BUYER**. A
 *   whitespace-only cell is what a spreadsheet produces from a stray space
 *   bar, and treating it as present would mark the coin sold and hide it.
 *   So both are TRIMMED before they are tested.
 *
 * Get either backwards and the failure is silent in the direction that
 * matters: a row quietly in or quietly out of an import of hundreds.
 *
 * ---- WHAT THIS IS NOT ----
 * *** THIS DOES NOT SET `collectionStatus`, EVER. *** See the long note in
 * types/collection-status.ts: nothing may derive a coin's collection status
 * from its sold fields, because a sold date can outlive a sale that fell
 * through and only the owner's dropdown may move a coin out of his
 * collection. This answers a different question — "is the file telling me
 * this one is gone?" — and it is asked exactly once, about a record that is
 * being created for the first time, to decide whether to create it at all.
 */

/** The three fields the rule reads. Nothing else about a coin matters here. */
export interface SoldFields {
  soldDate?: string | null;
  soldPrice?: number | null;
  soldTo?: string | null;
}

/**
 * Is there a usable number here?
 *
 * `0` is present. `null`, `undefined` and `NaN` are not — NaN because an
 * unparseable cell is not a price, and because `NaN` would otherwise be
 * "present" by every test that is not this one.
 */
function hasNumber(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Is there text here once the spaces are taken off? */
function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * THE PREDICATE. A record is sold when it has a sold date, a sold price or
 * a buyer — any one of them.
 */
export function isSoldRecord(record: SoldFields): boolean {
  return hasText(record.soldDate) || hasNumber(record.soldPrice) || hasText(record.soldTo);
}

/**
 * The one sentence the user is shown, kept here beside the rule it
 * describes so the wording in three dialogs cannot drift from the code or
 * from each other.
 */
export const SOLD_RULE_SENTENCE =
  'A coin counts as sold when it has a sold date, a sold price or a buyer.';
