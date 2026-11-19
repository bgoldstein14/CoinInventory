/**
 * "Has this record been sold?" for the import filter, shared by the QIF, CSV
 * and Excel importers so the "exclude sold coins" option means the same thing
 * in all three.
 *
 * A record is sold when it has any one of: a sold date, a sold price, or a buyer.
 * - Sold price is tested for presence, not truthiness: 0 is a real price
 *   (given away or written off).
 * - Sold date and buyer are trimmed first: a whitespace-only cell is not a value.
 *
 * This only decides whether to import a new record. It never sets
 * `collectionStatus`, which is changed only by the user (see
 * types/collection-status.ts).
 */

/** The fields the rule reads. */
export interface SoldFields {
  soldDate?: string | null;
  soldPrice?: number | null;
  soldTo?: string | null;
}

/** True for any number including 0; false for null, undefined and NaN. */
function hasNumber(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Is there text here once the spaces are taken off? */
function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A record is sold when it has a sold date, a sold price or a buyer. */
export function isSoldRecord(record: SoldFields): boolean {
  return hasText(record.soldDate) || hasNumber(record.soldPrice) || hasText(record.soldTo);
}

/** User-facing description of the rule, shown in all three import dialogs. */
export const SOLD_RULE_SENTENCE =
  'A coin counts as sold when it has a sold date, a sold price or a buyer.';
