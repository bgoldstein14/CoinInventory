import { CoinRecord, SpotPrices } from './coin.model';
import { computeMeltValue } from '../services/inventory/inventory-metrics';

/**
 * Column order for the inventory table.
 *
 * THIS ARRAY IS THE SINGLE SOURCE OF TRUTH FOR COLUMN ORDER.
 * ---------------------------------------------------------
 * Two things read it, and that is exactly why it must stay the only place the
 * order is written down:
 *   1. the column picker (the "Columns" tick-box panel) lists options in this
 *      order, and
 *   2. InventoryColumnsStore sorts the VISIBLE column list into this order, so
 *      the table's `<th>`/`<td>` sequence follows it too.
 * Re-ordering the template instead would make those two disagree, which is how
 * you end up with a tick-box panel whose order does not match the grid.
 *
 * Key changes from legacy schema:
 * - Replaced 'name' with 'coinType' (aligns with CoinRecord changes)
 * - Added 'pmWeightGrams', 'pmPercent', 'meltValue' for precious metal tracking
 * - 'certNumber' sits immediately before 'grade' (owner request): the slab's
 *   certification and the grade printed on that slab are one idea, so they read
 *   as a pair. See the note on the 'certNumber' entry below for WHAT that
 *   column actually displays.
 */
export const inventoryColumnOrder = [
  'year',
  'mintMark',
  // ---- Denomination immediately after Mint Mark -----------------------------
  // Moved here from between 'category' and 'country' at the owner's request.
  // Year / Mint Mark / Denomination is how a coin is spoken about and written
  // on a holder -- "1881-S Dollar" -- so the three now read together, and the
  // grid's leading columns match the first line of the coin editor.
  'denomination',
  'coinType', // Changed from 'name' - displays the coin type/variant
  // ---- Cert immediately before Grade ----------------------------------------
  // Moved here from its old position (it used to sit between 'variety' and the
  // since-removed 'dealer' column).
  // Despite the key being `certNumber`, the cell renders a BADGE built from the
  // grading company AND the number — "PCGS #12345678" — falling back to just
  // the company ("PCGS") when no number is recorded. See certBadgeLabel() at the
  // bottom of this file.
  'certNumber',
  'grade',
  'category',
  'country',
  'purchasePrice',
  'currentValue',
  'meltValue', // New: computed melt value based on PM content and spot prices
  'soldPrice',
  'variety',
  // NOTE: a 'dealer' column used to sit here. The coin-level dealer field was
  // removed at the owner's request -- who a coin came from is already recorded,
  // per event, on its transaction rows. (Transactions still have their own
  // dealer; that is a different thing and it stays.)
  'coinSet',
  'metalContent',
  'weight',
  'pmWeightGrams', // New: precious metal weight in grams
  'pmPercent', // New: precious metal purity percentage
  // NOTE: there used to be a 'tags' column here. Nothing in the app could ever
  // put a tag on a coin (no editor input, no bulk-edit field, no importer), so
  // the column could only ever display a dash. The whole feature was removed.
  'source'
] as const;

export type InventoryColumn = (typeof inventoryColumnOrder)[number];

/**
 * Human-readable labels for each inventory column.
 * These labels are displayed in the table header and column selector UI.
 */
export const inventoryColumnLabels: Record<InventoryColumn, string> = {
  coinType: 'Type', // Changed from 'Name' - displays coin variant (e.g., "Walking Liberty")
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denom.',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Cost',
  currentValue: 'Value',
  meltValue: 'Melt Value', // New: computed melt value
  soldPrice: 'Sold Price',
  mintMark: 'MM',
  variety: 'Variety',
  certNumber: 'Cert',
  coinSet: 'Set',
  metalContent: 'Metal',
  // GRAMS. This read 'Weight (oz)' until the gross Weight column was switched
  // from troy ounces to grams -- see server/migrations/008-weight-to-grams.sql,
  // which multiplied the stored values by 31.1034768. The two weight columns
  // in this grid now share a unit, so 'Weight (g)' and 'PM Weight (g)' can be
  // read side by side and divided into one another without conversion.
  weight: 'Weight (g)',
  pmWeightGrams: 'PM Weight (g)', // New: precious metal weight in grams
  pmPercent: 'PM %', // New: precious metal purity percentage
  source: 'Source'
};

/**
 * Default set of visible columns when the inventory table first loads.
 * Users can customize this via the column selector UI.
 */
// Listed in the same order as inventoryColumnOrder above, purely so the two
// read alike. The order here has no effect: normalizeVisibleColumns() re-sorts
// whatever it is given by the canonical list, so this array is really a SET of
// "which columns start switched on".
export const defaultVisibleColumns: InventoryColumn[] = [
  'year',
  'mintMark',
  'denomination',
  'coinType',
  'grade',
  'category',
  'country',
  'purchasePrice',
  'currentValue'
];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: InventoryColumn;
  direction: SortDirection;
}

export function formatDenominationDisplay(value: string): string {
  const text = (value ?? '').trim();
  if (!text) return '—';

  return text
    .replace(/1\/-/gi, '1 sh')
    .replace(/2\/-/gi, '2 sh')
    .replace(/5\/-/gi, '5 sh')
    .replace(/1\s*shilling/gi, '1 sh')
    .replace(/2\s*shilling/gi, '2 sh')
    .replace(/5\s*shilling/gi, '5 sh');
}

/**
 * Renders a melt value for display: currency to two decimals, or a dash.
 *
 * `null` from computeMeltValue() means "we cannot say" — no pure-metal weight,
 * no metal name, or no spot price for that metal. It does NOT mean "worth
 * nothing", so it must never render as "$0.00"; it renders as the same em-dash
 * every other unknown cell in the grid uses.
 *
 * Exported because the detail panel needs exactly the same rendering, and a
 * second hand-rolled `toFixed(2)` there would be one more place to drift.
 */
export function formatMeltValue(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

/**
 * Formats a cell value for display in the inventory table.
 * Each column has custom formatting logic (currency, percentages, badges, etc.).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A THIRD PARAMETER (and why it is optional)
 * ---------------------------------------------------------------------------
 * Every other column can be worked out from the coin alone. Melt value cannot:
 * it also needs today's spot prices, which live on InventoryService. There
 * were two sensible ways to bridge that gap —
 *
 *   (a) pass the prices in here, or
 *   (b) special-case `meltValue` in the inventory-table template the way
 *       `grade` and `certNumber` already are, calling inv.meltValue(coin).
 *
 * (a) was chosen. The reason is testability: this stays ONE pure function of
 * its arguments, so the interesting cases — a real figure, and the null/dash
 * case — are unit-testable with a plain object and no DOM, which matters
 * because this test suite runs under Node with no jsdom. Option (b) would have
 * pushed the formatting decision into a template, where the only way to check
 * it is to render something.
 *
 * It is OPTIONAL so that every existing caller (and every existing test) keeps
 * compiling unchanged. Omitting it is not a silent wrong answer: with no
 * prices there is nothing to price the metal at, so the cell correctly reads
 * "—", exactly as it would for a coin with no precious metal.
 *
 * Note it calls computeMeltValue() rather than doing the arithmetic. That is
 * deliberate and load-bearing — see the comment at the `meltValue` case below.
 *
 * @param coin - The coin record to format
 * @param column - The column identifier
 * @param spotPrices - Current spot prices; only the `meltValue` column uses them
 * @returns Formatted string for display
 */
export function formatInventoryCell(
  coin: CoinRecord,
  column: InventoryColumn,
  spotPrices?: SpotPrices
): string {
  switch (column) {
    case 'coinType': // Changed from 'name' - displays coin variant
      return coin.coinType || '—';

    case 'grade':
      return coin.grade || '—';

    case 'category':
      return coin.category || '—';

    case 'denomination':
      return formatDenominationDisplay(coin.denomination);

    case 'country':
      return coin.country || '—';

    case 'year': // Now a string (not number|null), so no conversion needed
      return coin.year || '—';

    case 'purchasePrice':
      return `$${coin.purchasePrice.toFixed(2)}`;

    case 'currentValue':
      return `$${coin.currentValue.toFixed(2)}`;

    case 'meltValue':
      // *** NEVER DO THE ARITHMETIC HERE. ALWAYS CALL computeMeltValue(). ***
      //
      // This column used to be a stub that returned a dash for every coin, and
      // the comment that sat here offered this formula to whoever finished it:
      //     (pmWeightGrams * pmPercent / 100) * spotPricePerGram
      // That formula is WRONG and implementing it would have re-broken a bug
      // that was fixed earlier. It applies purity TWICE: `pmWeightGrams` is
      // already the weight of the PURE precious metal, not the coin's gross
      // weight (see the header of services/pm-reference.ts, which works it
      // through on a $20 Saint-Gaudens: 33.44 g gross, 90% fine, so
      // pmWeightGrams = 30.09 g, which IS the 0.9675 oz AGW the trade quotes).
      // Discounting that by 0.90 a second time understates every figure by the
      // purity factor -- about 10% on 90% gold and silver, 60% on a 40% silver
      // Kennedy half.
      //
      // The correct sum, and the ONLY place it is written down, is
      // computeMeltValue() in services/inventory/inventory-metrics.ts:
      //     (pmWeightGrams / GRAMS_PER_TROY_OZ) * spotPricePerTroyOunce
      // Delegating to it means there is exactly one copy of the maths in the
      // app, so it cannot be half-fixed again.
      //
      // No prices passed in -> nothing to price the metal at -> "—", which is
      // the same honest "unknown" answer computeMeltValue gives for a coin
      // with no precious metal in it.
      return formatMeltValue(spotPrices ? computeMeltValue(coin, spotPrices) : null);

    case 'soldPrice':
      return (coin.soldPrice ?? 0) > 0 ? `$${(coin.soldPrice ?? 0).toFixed(2)}` : '—';

    case 'mintMark':
      return coin.mintMark || '—';

    case 'variety':
      return coin.variety || '—';

    case 'certNumber':
      return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';

    case 'coinSet':
      return coin.coinSet || '—';

    case 'metalContent':
      return coin.metalContent || '—';

    // Three decimals, matching the pmWeightGrams cell below it. Both columns
    // are now grams, so showing one to four places and the other to three
    // would make two comparable figures look like different kinds of number.
    // Four decimals suited troy ounces, where the fourth place is still worth
    // about 3 mg; in grams it is a tenth of a milligram, which no coin scale
    // in a collector's house can resolve and which only adds noise to a dense
    // grid. The coin editor still accepts and stores five -- see the
    // DECIMAL(12,5) column -- this is a display choice for the grid alone.
    case 'weight':
      return (coin.weight ?? 0) > 0 ? `${(coin.weight ?? 0).toFixed(3)}` : '—';

    case 'pmWeightGrams': // New: precious metal weight in grams
      return coin.pmWeightGrams ? `${coin.pmWeightGrams.toFixed(3)}` : '—';

    case 'pmPercent': // New: precious metal purity percentage
      return coin.pmPercent ? `${coin.pmPercent.toFixed(1)}%` : '—';

    case 'source':
      return coin.source;

    default:
      return '—';
  }
}

export function gradeBadgeClass(grade: string): string {
  const normalized = (grade || '').trim().toUpperCase();
  if (!normalized) return 'badge badge--ungraded';
  if (/^(MS|PR|PF)/.test(normalized)) return 'badge badge--mint';
  if (/^(AU|XF|VF)/.test(normalized)) return 'badge badge--circulated';
  return 'badge badge--worn';
}

export function certBadgeLabel(coin: CoinRecord): string | null {
  if (!coin.certCompany && !coin.certNumber) return null;
  const company = coin.certCompany || 'Cert';
  return coin.certNumber ? `${company} #${coin.certNumber}` : company;
}

export const METAL_CONTENT_OPTIONS = [
  'Gold',
  'Silver',
  'Platinum',
  'Copper',
  'Copper-Nickel',
  'Nickel',
  'Zinc',
  'Brass',
  'Bronze',
  'Steel',
  'Aluminum',
  'Nickel-Brass',
  'Clad',
  'Other'
] as const;
