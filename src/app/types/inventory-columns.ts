import { CoinRecord, SpotPrices } from './coin.model';
import { CatalogOption, coinCatalogReference } from './catalog-reference';
import { collectionStatusLabel } from './collection-status';
import { computeMeltValue } from '../services/inventory/inventory-metrics';
import { denominationDisplay } from '../services/denominations/denomination-display';
import {
  PickerDenomination,
  denominationSelectionFor
} from '../components/coin-editor-form/denomination-picker';

/**
 * Column order for the inventory table.
 *
 * THIS ARRAY IS THE SINGLE SOURCE OF TRUTH FOR COLUMN ORDER.
 * Two things read it, and that is exactly why it must stay the only place the
 * order is written down:
 *   1. the column picker (the "Columns" tick-box panel) lists options in this
 *      order, and
 *   2. InventoryColumnsStore sorts the VISIBLE column list into this order, so
 *      the table's `<th>`/`<td>` sequence follows it too.
 * Re-ordering the template instead would make those two disagree, which is how
 * you end up with a tick-box panel whose order does not match the grid.
 */
export const inventoryColumnOrder = [
  'year',
  'mintMark',
  // Year / Mint Mark / Denomination is how a coin is spoken about and written
  // on a holder -- "1881-S Dollar" -- so the three read together here, and
  // the grid's leading columns match the first line of the coin editor.
  'denomination',
  'coinType',
  // Cert sits immediately before Grade: the slab's certification and the
  // grade printed on that slab are one idea and read as a pair.
  //
  // Despite the key being `certNumber`, the cell is a BADGE carrying the
  // company AND the number -- "PCGS #12345678" -- falling back to just the
  // company when no number is recorded. See certBadgeLabel() at the bottom of
  // this file. OFF by default: the slab number is reference data most people
  // do not want on screen.
  //
  // THERE IS NO SEPARATE COMPANY COLUMN, AND THAT IS DELIBERATE: certBadgeLabel()
  // already leads with the company, so a company-only column alongside this
  // one would render "NGC" next to "NGC #2599001".
  'certNumber',
  'grade',
  // Status: "do I actually have this one?"
  // ON by default, which is the point of it. Without a visible status a coin
  // on the want list looks exactly like a coin in the cabinet, and the one
  // thing this feature must never allow is the owner mistaking the second for
  // the first. See src/app/types/collection-status.ts for the five values and
  // why they are those five.
  //
  // WHY HERE. Everything to the left of this point describes the COIN — what
  // it is, how it is graded. Status is the first column about the OWNER's
  // relationship to it, and what follows (category, country, then the money)
  // is the same kind of thing, so this is the seam.
  //
  // This column NEVER renders an em-dash. A coin with no stored status is
  // Owned, not unknown; see the `collectionStatus` case in
  // formatInventoryCell() below.
  'collectionStatus',
  'category',
  'country',
  'purchasePrice',
  'currentValue',
  'meltValue',
  'soldPrice',
  'variety',
  // Catalogue reference: "Sear 6819", "Hendin 1234", "RIC II.1 234" -- the
  // catalogue and the number read as one cell, composed by
  // coinCatalogReference() in types/catalog-reference.ts.
  //
  // WHY IT SITS AGAINST VARIETY. Before this column existed, catalogue
  // references got typed into the VARIETY field because there was nowhere
  // else for them. With the two adjacent, a user can see at a glance which
  // coins still have a reference in the wrong box and move it.
  //
  // OFF by default. Most collectors of modern coins will never record a
  // catalogue reference, and an always-empty column in a grid this dense
  // pushes the money columns off the right-hand edge. It is one tick in the
  // Columns panel for the people who collect ancients and world coins, where
  // it is often the only thing that identifies the coin at all.
  'catalogReference',
  'coinSet',
  // Storage sits immediately after Set.
  // The two ask the only two organising questions a collector has, and they
  // are NOT the same question: Set is the conceptual grouping a coin belongs
  // to ("Morgan Set"), Storage is the shelf you walk to ("Safe deposit box
  // 2"). A coin is routinely in both. Reading them side by side is what makes
  // the difference obvious to anyone looking at the grid for the first time.
  //
  // OFF by default: free text, often long, and in a grid this dense it would
  // push the money columns off the right-hand edge for the majority of users
  // who keep everything in one album.
  'storageLocation',
  'metalContent',
  'weight',
  'pmWeightGrams',
  'pmPercent',
  'source'
] as const;

export type InventoryColumn = (typeof inventoryColumnOrder)[number];

/** Headers for the table and the column-selector panel. */
export const inventoryColumnLabels: Record<InventoryColumn, string> = {
  coinType: 'Type',
  grade: 'Grade',
  category: 'Category',
  denomination: 'Denom.',
  country: 'Country',
  year: 'Year',
  purchasePrice: 'Cost',
  currentValue: 'Value',
  meltValue: 'Melt Value',
  soldPrice: 'Sold Price',
  mintMark: 'MM',
  variety: 'Variety',
  // Spelled out rather than shortened to 'Cat.' or 'Ref.': on its own 'Ref'
  // could be a certification number or an internal stock number, and 'Cat.'
  // reads as Category, which is a column two places to the right. The header
  // is wider than most cells in this column, which is acceptable for a column
  // that is off by default and switched on deliberately.
  catalogReference: 'Catalogue Ref.',
  certNumber: 'Cert',
  // One word, because the cell values are one word too ("Owned", "Wanted") and
  // a header wider than its data wastes space in a grid that has none spare.
  collectionStatus: 'Status',
  coinSet: 'Set',
  // 'Storage', not 'Location'. This grid already has a Country column, and in
  // that company "Location" reads as "where in the world is this coin from"
  // rather than "which drawer is it in" -- which is the opposite of what the
  // field records. Keep any future wording unambiguous against Country.
  storageLocation: 'Storage',
  metalContent: 'Metal',
  // GRAMS, and the unit is in the header on purpose: the two weight columns
  // in this grid share a unit, so 'Weight (g)' and 'PM Weight (g)' can be
  // read side by side and divided into one another without conversion.
  weight: 'Weight (g)',
  pmWeightGrams: 'PM Weight (g)',
  pmPercent: 'PM %',
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
  // ON by default for the reason spelled out on its entry in
  // inventoryColumnOrder: an invisible status makes a want-list coin look
  // identical to one in the cabinet. normalizeVisibleColumns unions a saved
  // preference with this list, so a newly-defaulted-on column reaches
  // existing users on their next load with no migration and no version stamp
  // on the storage key.
  'collectionStatus',
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

/* THE COIN'S DENOMINATION, AS EVERY READ PATH MUST WRITE IT
 *
 * WHY THIS FUNCTION EXISTS AT ALL
 *
 * A coin carries TWO denomination fields: `denominationId` (the canonical
 * link, frequently NULL) and `denomination` (what the source said, never
 * rewritten). The coin editor reads the id. Everything else — this grid, the
 * search box, the statistics chart, the printed reports — would otherwise
 * read only the text.
 *
 * That split is not a cosmetic inconsistency waiting to happen; it is a
 * SILENT one. As soon as ids are set, the same coin reads `8 Reales` in the
 * editor and `Pillar Dollar` in the grid, nothing throws and no test fails.
 * So all four read paths come through here.
 *
 * WHY IT RESOLVES THE TEXT AND DOES NOT JUST LOOK THE ID UP
 *
 * `denominationLabelById()` would be the obvious implementation and it is the
 * wrong one: `DenominationId` is NULL on most rows, so an id-only read path
 * would show all of them as unresolved.
 *
 * `denominationSelectionFor()` is what the editor's picker already uses. It
 * prefers the stored id and falls back to putting the TEXT through
 * `resolveDenomination` — the same resolver the backfill and the importers
 * use, not a second copy of the rules. The property this is judged on:
 *
 *     A COIN READS IDENTICALLY BEFORE AND AFTER THE IDS ARE BACKFILLED.
 *
 * Nothing here writes. A resolution is SHOWN, never saved — rendering a grid
 * must not rewrite the collection it is rendering.
 *
 * WHY THE SHILLING REWRITE IS APPLIED TO THE LABEL AND NOT TO THE TEXT
 *
 * `formatDenominationDisplay` above turns '5/-' into '5 sh'. Two decisions,
 * and they point opposite ways on purpose:
 *
 *   THE RESOLVED LABEL IS NORMALISED. coin-editor-form.html renders every
 *   <option> in the denomination picker through this same function, so the
 *   dropdown says '5 sh (Crown)'. A grid printing the raw '5/- (Crown)'
 *   would re-create, in a new place, the very two-spellings-of-one-coin
 *   problem this change exists to remove.
 *
 *   THE RECORDED TEXT IS NOT. It is evidence of what the source wrote, and
 *   showing it verbatim is the entire point of the unresolved form: the user
 *   has to RECOGNISE the value before they can re-map it. `Coins.Denomination`
 *   is never rewritten; rewriting it on the way to the screen is the same
 *   loss, one layer up.
 *
 * Note the ORDER below, which is load-bearing: the label is normalised only
 * when there IS one. `formatDenominationDisplay(null)` answers '—', and an
 * em-dash is a perfectly good non-empty "label" as far as
 * `denominationDisplay()` is concerned — so normalising first would make
 * every unresolved coin in the grid read '—' and the collection would look
 * empty. composition-breakdown.ts documents the same trap.
 */

/** What `coinDenominationDisplay` needs off a coin. Widened for the reports. */
export interface DenominationBearing {
  denomination: string;
  denominationId?: number | null;
  country?: string;
}

/**
 * One coin's denomination, exactly as every screen must write it.
 *
 * @param coin          the record; only three fields are read
 * @param denominations the `Denominations` lookup, already in memory on
 *                      InventoryService. NO SERVER ROUND TRIP: the grid
 *                      renders hundreds of rows and `denominationSelectionFor`
 *                      indexes the list once per array identity (a WeakMap in
 *                      denomination-picker.ts), so a row costs two map
 *                      lookups and two alias folds.
 *
 * *** THE LOOKUP IS OPTIONAL, AND AN ABSENT ONE IS NOT A WRONG ANSWER. ***
 * With no list there is nothing to resolve against, so the coin's own text
 * stands as its own label and the cell renders precisely what this app has
 * rendered for years. That matters twice: during start-up hydration, where
 * the alternative is a flash of "unresolved" across the whole grid, and in
 * the many callers and specs that have no lookup to give.
 *
 * *** THE STRING IS BUILT BY denominationDisplay() AND NOWHERE ELSE. ***
 * That is the one place the rule may be written down, and its spec greps the
 * whole of src/ and fails the build if a second copy appears — because two
 * copies are a FORK, not a duplicate.
 */
export function coinDenominationDisplay(
  coin: DenominationBearing,
  denominations?: readonly PickerDenomination[]
): string {
  const label = resolvedDenominationLabel(coin, denominations ?? []);
  return denominationDisplay(label ? formatDenominationDisplay(label) : null, coin.denomination);
}

/**
 * The lookup Label this coin resolves to, or null.
 *
 * Separated from the formatting above so the "which row is this?" question
 * and the "how is it written?" question stay apart — the first is shared
 * with the editor and the migration, the second is presentation.
 */
function resolvedDenominationLabel(
  coin: DenominationBearing,
  denominations: readonly PickerDenomination[]
): string | null {
  const selection = denominationSelectionFor(
    coin.denominationId,
    coin.denomination,
    coin.country,
    denominations
  );

  // `ready` is false only while the lookup list is empty — see the field's
  // own note in denomination-picker.ts. Judged against an empty list every
  // coin looks unresolvable, so the honest answer is not "unresolved", it is
  // "we have nothing to contradict the text with", and the text stands.
  if (!selection.ready) {
    const text = String(coin.denomination ?? '').trim();
    return text.length > 0 ? text : null;
  }

  return selection.label;
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
 * Formats one cell for the inventory table (currency, percentages, badges).
 *
 * WHY THE THREE LOOKUP PARAMETERS EXIST, AND WHY THEY ARE OPTIONAL
 *
 * Most columns can be worked out from the coin alone. Three cannot, because
 * the coin stores a key and the value behind it lives on InventoryService:
 * `meltValue` needs today's spot prices, `catalogReference` needs the
 * Catalogs lookup, `denomination` needs the Denominations lookup.
 *
 * They are passed in rather than special-cased in the template so that this
 * stays ONE pure function of its arguments, unit-testable with a plain
 * object and no DOM — which matters because this suite runs under Node with
 * no jsdom. Pushing the decision into a template would mean the only way to
 * check it is to render something.
 *
 * They are OPTIONAL so existing callers and tests keep compiling. Omitting
 * one is never a silent wrong answer, but note the two cases differ:
 *
 *   NO PRICES — there is genuinely nothing to price the metal at, so the
 *   melt cell reads "—", exactly as for a coin with no precious metal.
 *
 *   NO CATALOGUE LIST — we still know the NUMBER the user typed, so the cell
 *   reads "6819" rather than "Sear 6819". Hiding real data behind an em-dash
 *   would be worse, and inventing a name worse still.
 *
 *   NO DENOMINATIONS LIST — the coin's own text stands as its label; see
 *   coinDenominationDisplay() above for why that is the honest answer rather
 *   than a degraded one.
 *
 * Note it calls computeMeltValue() rather than doing the arithmetic. That is
 * deliberate and load-bearing — see the comment at the `meltValue` case below.
 *
 * @param coin - The coin record to format
 * @param column - The column identifier
 * @param spotPrices - Current spot prices; only the `meltValue` column uses them
 * @param catalogs - The Catalogs lookup; only `catalogReference` uses it
 * @param denominations - The Denominations lookup; only `denomination` uses it
 * @returns Formatted string for display
 */
export function formatInventoryCell(
  coin: CoinRecord,
  column: InventoryColumn,
  spotPrices?: SpotPrices,
  catalogs?: readonly CatalogOption[],
  denominations?: readonly PickerDenomination[]
): string {
  switch (column) {
    case 'coinType':
      return coin.coinType || '—';

    case 'grade':
      return coin.grade || '—';

    case 'category':
      return coin.category || '—';

    // NOT `formatDenominationDisplay(coin.denomination)`. Reading the text
    // alone makes this cell and the coin editor disagree about the same coin
    // as soon as `denominationId` is set — see coinDenominationDisplay()
    // above, which also explains why an absent fifth argument still renders
    // the right thing.
    case 'denomination':
      return coinDenominationDisplay(coin, denominations);

    case 'country':
      return coin.country || '—';

    case 'year': // a string, so that ranges like "1916-1945" survive
      return coin.year || '—';

    case 'purchasePrice':
      return `$${coin.purchasePrice.toFixed(2)}`;

    case 'currentValue':
      return `$${coin.currentValue.toFixed(2)}`;

    case 'meltValue':
      // *** NEVER DO THE ARITHMETIC HERE. ALWAYS CALL computeMeltValue(). ***
      //
      // The tempting formula is WRONG:
      //     (pmWeightGrams * pmPercent / 100) * spotPricePerGram
      // It applies purity TWICE. `pmWeightGrams` is ALREADY the weight of the
      // pure precious metal, not the coin's gross weight (see the header of
      // services/pm-reference.ts, which works it through on a $20
      // Saint-Gaudens: 33.44 g gross, 90% fine, so pmWeightGrams = 30.09 g,
      // which IS the 0.9675 oz AGW the trade quotes). Discounting that by
      // 0.90 again understates every figure by the purity factor -- about
      // 10% on 90% gold and silver, 60% on a 40% silver Kennedy half.
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

    // The catalogue and the number as one reference. Composed by
    // coinCatalogReference() rather than here, because the search box in
    // features/inventory/inventory-filter.store.ts has to build the exact
    // same string — a cell the user can see but cannot search for is a bug
    // report, and two copies of `${name} ${number}` is how you get one.
    //
    // An em-dash only when there is genuinely nothing: a coin with a number
    // but no resolvable catalogue still shows the number. See the note on
    // the `catalogs` parameter above.
    case 'catalogReference':
      return coinCatalogReference(catalogs, coin.catalogId, coin.catalogNumber) || '—';

    case 'certNumber':
      return coin.certCompany || coin.certNumber ? `${coin.certCompany} ${coin.certNumber}`.trim() || '—' : '—';

    // *** THE ONLY CELL IN THIS GRID THAT CANNOT RENDER AN EM-DASH. ***
    //
    // Every other case above answers a missing value with '—', meaning "we do
    // not know". A missing status is not unknown: a coin with no stored status
    // is OWNED, and saying anything else about it is false. Plenty of coins
    // arrive here with `collectionStatus` undefined, so a dash would put a
    // visible hole across the whole collection and invite the user to go and
    // "fix" hundreds of rows that were never broken.
    //
    // collectionStatusLabel() is what guarantees that, for absent, empty AND
    // unrecognised values alike. Do not replace it with a lookup into
    // COLLECTION_STATUS_LABELS, and do not add a `|| '—'`.
    case 'collectionStatus':
      return collectionStatusLabel(coin.collectionStatus);

    case 'coinSet':
      return coin.coinSet || '—';

    // Free text, shown exactly as typed. An ordinary dash when blank, which
    // unlike Status is the honest answer -- until the user records where a
    // coin lives, the app genuinely does not know.
    case 'storageLocation':
      return coin.storageLocation || '—';

    case 'metalContent':
      return coin.metalContent || '—';

    // Three decimals, matching the pmWeightGrams cell below it: both columns
    // are grams, and showing one to four places and the other to three would
    // make two comparable figures look like different kinds of number. In
    // grams a fourth place is a tenth of a milligram, which no coin scale in
    // a collector's house can resolve. The editor still accepts and stores
    // five (DECIMAL(12,5)); this is a display choice for the grid alone.
    case 'weight':
      return (coin.weight ?? 0) > 0 ? `${(coin.weight ?? 0).toFixed(3)}` : '—';

    case 'pmWeightGrams':
      return coin.pmWeightGrams ? `${coin.pmWeightGrams.toFixed(3)}` : '—';

    case 'pmPercent':
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
 * KEYED ON THE COMPLETE LETTER RUN, NEVER ON A PREFIX, which is what makes
 * this table order-independent: `VF` and `F` are two different keys, and no
 * amount of reordering can make one answer for the other. Do not rewrite it
 * as a sequence of anchored prefix tests — that is correct only by
 * arrangement (`VF` before `F`, `VG` before `G`, `FR` before `F`), and its
 * failure mode is a wrong COLOUR rather than an error, so nothing catches it.
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
 * The tiers run MS green, PF its own gold, VF the established blue with XF a
 * shade darker, and the circulated grades below them through earth tones.
 * See `styles/_controls.scss` for the colours.
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
