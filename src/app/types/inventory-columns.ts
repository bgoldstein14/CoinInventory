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
 * - 'certCompany' ("Certified By") sits immediately before 'certNumber' (owner
 *   request: "show the certification company to the left of the grade"). It is
 *   the only cert column that is ON by default, so in the grid as shipped it is
 *   the one the user sees next to Grade. The long note on its entry below
 *   explains why it is a new column and why it went to the left of 'certNumber'
 *   instead of between 'certNumber' and 'grade'.
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
  // ---- The cert block, ending flush against Grade ---------------------------
  // Two columns, not one, and they are NOT interchangeable:
  //
  //   certCompany ("Certified By") — the grading company ALONE: "NGC". Narrow,
  //     and ON by default. Added at the owner's request: "we need to show the
  //     certification company to the left of the grade".
  //   certNumber  ("Cert")         — a BADGE carrying company AND number,
  //     "PCGS #12345678", falling back to just the company when no number is
  //     recorded. Wider, and OFF by default. See certBadgeLabel() at the
  //     bottom of this file.
  //
  // WHY A NEW COLUMN RATHER THAN NARROWING THE EXISTING ONE.
  // Repurposing 'certNumber' to show only the company would have been fewer
  // lines, but it is off by default precisely because the slab number is
  // reference data most people do not want on screen — so anyone who HAS
  // ticked it has gone looking for that number. Quietly replacing it with the
  // company would take away the one thing they switched the column on for.
  //
  // WHY certCompany SITS BEFORE certNumber RATHER THAN BETWEEN IT AND GRADE.
  // 'certNumber' immediately precedes 'grade' at the owner's earlier request
  // (the slab's certification and the grade printed on that slab read as a
  // pair), and that adjacency is pinned by tests in
  // features/inventory/inventory-columns.store.spec.ts. Wedging the new column
  // into that gap would have broken it. Sitting to the LEFT of certNumber
  // satisfies both requests at once: the cert block ends flush against Grade,
  // and because certNumber is off by default, the column the user actually
  // sees immediately left of Grade IS "Certified By".
  'certCompany',
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
  // Two different headers for two different columns -- see the cert block in
  // inventoryColumnOrder.
  //
  // 'Cert. By' is deliberately a shortened PHRASE rather than a noun like
  // 'Company': the header has to say what the cell means on a RAW coin too,
  // where it reads as an em-dash, and "Cert. By: —" is honest where
  // "Company: —" is just blank.
  //
  // It was 'Certified By' first. That was long enough to force the header to
  // wrap to two lines -- the header, not the data, is the widest thing in this
  // column, since the values are 3-5 letters (NGC, PCGS, ANACS) -- and the
  // owner asked for the shorter label rather than the taller header row. Keep
  // any future wording about this short for the same reason; see the note on
  // `.column-certCompany` in inventory-table.scss.
  certCompany: 'Cert. By',
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
  // ON by default, unlike its sibling 'certNumber'. The owner said "we need to
  // show the certification company" -- a column that only appears once the
  // user has found it in the Columns picker is not shown. Being in this list
  // is also what makes the change reach EXISTING users: normalizeVisibleColumns
  // unions a saved preference with these defaults, so the new column turns up
  // on their next load with no migration and no version stamp on the storage
  // key. See InventoryColumnsStore.restoreFromStorage.
  'certCompany',
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

    // The grading company AND NOTHING ELSE -- "NGC", never "NGC 9000002-001".
    // That is the entire difference between this column and the 'certNumber'
    // case directly below, and it is the reason both exist. If you are ever
    // tempted to "tidy up" by folding one into the other, read the cert block
    // in inventoryColumnOrder first.
    case 'certCompany':
      return coin.certCompany || '—';

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

/**
 * Leading words that qualify a grade without changing which tier it is in:
 * "Choice VF" is a VF, "Gem BU" is a BU.
 */
const GRADE_TIER_MODIFIERS = /^(?:SUPERB|CHOICE|SELECT|NEARLY|NEAR|ABOUT|CH|SEL)[\s-]*/;

/**
 * Grade letters to the colour tier they belong to.
 *
 * Keyed on the COMPLETE letter run, never on a prefix, which is what makes
 * this table order-independent: `VF` and `F` are simply two different keys,
 * and no amount of reordering can make one answer for the other. An earlier
 * version tested anchored prefixes in a careful sequence and relied on `VF`
 * being checked before `F`, `VG` before `G`, and `FR` before `F`. That worked,
 * but it was correct only by arrangement -- and the failure mode was a wrong
 * COLOUR rather than an error, so nothing would have caught a reordering.
 * Reading the whole grade removes the hazard instead of managing it.
 */
const GRADE_TIERS: Readonly<Record<string, string>> = {
  // Struck for collectors. Off the circulated-to-mint ladder entirely, so it
  // gets its own hue rather than a place at the top of the scale.
  PF: 'pf', PR: 'pf', SP: 'pf',
  // Uncirculated.
  MS: 'ms', BU: 'ms', UNC: 'ms', GEM: 'ms',
  AU: 'au',
  XF: 'xf', EF: 'xf',
  VF: 'vf',
  F: 'f',
  VG: 'vg',
  G: 'g',
  // The bottom of the scale: About Good, Fair, Poor.
  AG: 'basal', FR: 'basal', PO: 'basal'
};

/**
 * Which colour tier a grade belongs to, as a CSS class.
 *
 * Reads the grade rather than pattern-matching its first letters: strip any
 * leading qualifier, take the unbroken run of letters that starts the grade,
 * and look the whole thing up. "VF20" yields `VF`, "FR2" yields `FR`, and
 * "MS64RB" yields `MS` -- each an exact key, with no chance of a shorter code
 * standing in for a longer one.
 *
 * A grade whose letters are not in the table returns the neutral grey rather
 * than a guess: showing an unrecognised grade in, say, green would assert
 * something untrue about the coin.
 *
 * The tiers follow the owner's request -- MS green, PF its own gold, VF the
 * established blue with XF a shade darker, and the circulated grades below
 * them through earth tones. See `styles/_controls.scss` for the colours.
 */
export function gradeBadgeClass(grade: string): string {
  const normalized = (grade || '').trim().toUpperCase().replace(GRADE_TIER_MODIFIERS, '');
  if (!normalized) return 'badge badge--ungraded';

  // The letters that OPEN the grade, taken whole. Everything after them -- the
  // number, a designation like RB or DCAM, a "+" -- refines the grade without
  // changing its tier.
  const letters = /^[A-Z]+/.exec(normalized)?.[0] ?? '';
  const tier = GRADE_TIERS[letters];

  return tier ? `badge badge--grade-${tier}` : 'badge badge--ungraded';
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
