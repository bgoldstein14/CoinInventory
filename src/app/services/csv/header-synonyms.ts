 /*
 * header-synonyms.ts — recognising a stranger's column headings.
 * ---- WHY THIS FILE EXISTS ----
 * Comparing a header to each field's key or label with `===` after
 * lower-casing is perfect and provably complete for the app's own
 * Export -> CSV: those columns are DERIVED from `CSV_MAPPABLE_FIELDS`, so
 * every one matches by construction (see export-import-round-trip.spec.ts).
 *
 * For anyone else's file it does almost nothing. A collector's workbook says
 * `Yr`, `Denom`, `MM`, `Cond`, `TPG`, `Cert #`, `Cost`, `FMV` -- not one of
 * which is a key or a label here -- so every column lands on the mapping
 * screen blank and the user faces twenty or thirty dropdowns before a single
 * coin can be imported. That applies equally to CSV and to the `.xlsx` path,
 * which is why the synonym table lives here rather than inside either
 * importer.
 *
 * ---- THE RULE THAT SHAPES EVERYTHING BELOW: A WRONG GUESS IS WORSE THAN A BLANK ----
 * A blank dropdown is a question the user answers in two seconds. A
 * filled-in dropdown is an answer they will not re-read. So a confident
 * wrong mapping does not cost two seconds, it costs the whole import --
 * silently, and usually only noticed months later when the numbers are wrong
 * and the original spreadsheet has moved on.
 *
 * Three mechanisms enforce that asymmetry:
 *
 *   1. NO SYNONYM FOR AN AMBIGUOUS WORD. `Price`, `Amount` and `Total` are
 *      deliberately absent. Each could be the purchase price, the current
 *      value or the sale price, and there is no way to tell from the heading.
 *
 *   2. EXACT BEATS SYNONYM. If one header matches a field's real key or label
 *      and another only matches a synonym of the same field, the exact one
 *      wins and the loose one is left blank. A sheet with both `Year` and
 *      `Date` columns keeps `Year` and asks about `Date`.
 *
 *   3. A TIE LEAVES BOTH BLANK. If two headers match the same field with the
 *      same confidence -- `Cost` and `Paid`, say -- neither is chosen. There
 *      is no principled way to pick, and picking wrong puts one column's
 *      numbers into the other's field.
 *
 * ---- WHAT NORMALISATION DOES *NOT* DO, AND WHY IT MATTERS HERE ----
 * `normalizeHeader` turns every run of non-alphanumeric characters into a
 * single space. It does NOT remove parenthesised text. That is deliberate and
 * load-bearing: `Weight (g)` and `Weight (oz)` differ only in the
 * parenthetical, and the gross-weight column is GRAMS since
 * server/migrations/008-weight-to-grams.sql. Collapsing the two would import
 * a Morgan dollar's 0.7734 troy ounces as 0.7734 grams -- a silent 31x
 * understatement that looks entirely plausible in a grid. The long comment in
 * csv.service.ts explains why leaving that column unmapped is the only honest
 * option; this file must not undo it.
 *
 * `Dealer` is refused for the same class of reason: the coin-level dealer
 * field was removed, so there is no field for that column to land on.
 *
 * ---- ONE SYNONYM IS DECIDED BY THE COLUMN'S VALUES, NOT BY ITS HEADING ----
 * `Date` is the only heading in the table that is ambiguous about WHICH KIND
 * of date it means. In numismatic usage a coin's date is its year, so `Date`
 * over `1881`, `1909-S`, `1873` is a Year column and mapping it is right.
 * The identical heading over `3/15/2024` is a calendar date, and only the
 * person who built the sheet knows whether it is when they bought the coin,
 * sold it, or catalogued it. Mapped onto Year it writes "2024" onto a Morgan
 * dollar under a dropdown that already says "Year", which nobody re-reads.
 *
 * So for that one heading the column's VALUES are consulted; the rules live
 * in csv/date-column-shape.ts, which also explains the sample size and how a
 * cell's Excel type is used where it is available. A column that turns out to
 * hold full dates makes NO claim at all -- it is not re-aimed at
 * `purchaseDate`, because that would be the same confident guess one field to
 * the left. Rule 1 above, applied to the one case where the heading alone
 * genuinely cannot tell.
 *
 * Every other date-ish synonym -- `date minted`, `date on coin`, `date
 * purchased`, `date sold` -- SAYS which date it is, so none of them is value-
 * checked. The ambiguity is in the word `date` standing on its own.
  */

import { CSV_MAPPABLE_FIELDS } from './mappable-fields';
import { ColumnValueEvidence, classifyColumnValues } from './date-column-shape';

/**
 * Reduce a header to a comparable form: lower case, every run of
 * non-alphanumeric characters collapsed to one space, trimmed.
 *
 * `Cert #` -> `cert`, `Est. Value` -> `est value`, `PURCHASE_PRICE` ->
 * `purchase price`, `Purchase $` -> `purchase`.
 *
 * Digits are KEPT (so `Weight (g)` -> `weight g` survives, and so would a
 * hypothetical `Grade 1`), and a header that normalises to nothing at all --
 * `---`, a run of spaces, a merged header cell's empty neighbour -- comes
 * back as the empty string, which never matches anything.
 */
export function normalizeHeader(raw: string): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .toLowerCase()
    // Includes the non-breaking space that Windows-1252 exports are full of.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Alternative spellings, by target field. Every entry is stored ALREADY
 * NORMALISED -- a spec asserts it -- so a lookup is a plain Map hit rather
 * than a scan.
 *
 * Omitted on purpose, each for a reason worth keeping:
 *
 *   price / amount / total   ambiguous between three money fields (see above)
 *   weight (oz) / ozt        wrong unit; see the header comment
 *   dealer                   the field no longer exists
 *   source                   provenance is ours, not the user's, to state --
 *                            it is importable only so an export round-trips
 *
 * A field's own key and label are NOT repeated here; exact matching already
 * covers them, and duplicating them would make this table look like the
 * source of truth when `CSV_MAPPABLE_FIELDS` is.
 */
export const HEADER_SYNONYMS: Record<string, string[]> = {
  coinType: [
    'type', 'series', 'coin', 'coin name', 'coin description',
    'name', 'description', 'design'
  ],
  denomination: ['denom', 'face value', 'face', 'face amount'],
  // `Date` means the date STRUCK in numismatic usage -- it is what is printed
  // on the coin -- which is why it belongs to Year and not to Purchase Date.
  // A sheet that means the acquisition spells it out (`Date Purchased`,
  // `Date Acquired`), and those are listed under purchaseDate below, so the
  // two never compete for the same heading.
  year: ['yr', 'date', 'coin date', 'date minted', 'year minted', 'mint year', 'date on coin'],
  category: ['cat', 'group', 'class', 'classification'],
  country: ['nation', 'issuer', 'origin', 'ctry', 'country of origin'],
  grade: ['cond', 'condition', 'grd'],
  certCompany: [
    'grader', 'service', 'tpg', 'grading service', 'grading company',
    'grading co', 'cert co', 'certifier', 'graded by', 'slabbed by', 'holder'
  ],
  certNumber: [
    'cert', 'cert no', 'cert num', 'cert id', 'certification number',
    'certification no', 'certificate', 'certificate number',
    'slab', 'slab no', 'slab number', 'serial', 'serial number'
  ],
  variety: ['var', 'vam', 'attribution', 'variety attribution', 'die variety'],
   /*
   * THE CATALOGUE REFERENCE. Every one of these points at the NUMBER field,
   * and `catalogId` deliberately has no entry of its own.
   *
   * A column headed `Catalog` holds "Sear" or "Sear 6819", never the row id
   * of a table in this application's database. `catalogNumber` is free text,
   * so landing the whole reference there is harmless and useful: it is then
   * visible in the grid, findable in the search box, and splittable in the
   * editor. Aimed at `catalogId` instead it would be a word on its way to an
   * INT column, normalised to NULL by the server and lost without a sound.
   *
   * `cat` is NOT here: it has meant Category since before catalogues were a
   * field, and re-aiming it would move data between two unrelated columns
   * for every user who has mapped such a sheet before. (It is also a prefix
   * of every spelling below, which is exactly the kind of near-miss rule 1
   * of this file exists to refuse.)
   *
   * `number`, `no` and `id` on their own are absent for the same reason as
   * `price` and `amount`: a sheet's bare `Number` column could as easily be
   * the certification number or the owner's own stock number, and there is
   * no way to tell from the heading.
   *
   * A BARE `ref` IS ALSO ABSENT, and that is somebody else's decision being
   * respected rather than a fresh one. This file already refused `Ref` as
   * unplaceable before catalogues existed (there is a test on it), and the
   * refusal still reads correctly: `Ref` over a column of slab numbers is a
   * certification reference. `Reference` spelled out, and every `cat`/
   * `catalog` form, are specific enough to claim.
    */
  catalogNumber: [
    'catalog', 'catalogue', 'catalog no', 'catalogue no', 'catalog num',
    'catalogue num', 'catalogue number', 'catalog ref', 'catalogue ref',
    'catalog reference', 'catalogue reference', 'cat no', 'cat num',
    'cat ref', 'reference', 'attribution no', 'km', 'km number',
    'sear', 'sear number', 'hendin', 'hendin number'
  ],
  mintMark: ['mint', 'mm', 'mint letter'],
  composition: ['comp', 'alloy', 'metal composition', 'fineness'],
  purchaseDate: [
    'date purchased', 'date of purchase', 'purchased', 'date acquired',
    'acquired', 'acquisition date', 'bought', 'date bought', 'buy date',
    'purchase dt'
  ],
  purchasePrice: [
    'cost', 'paid', 'price paid', 'paid price', 'purchase', 'purchase cost',
    'purchase amount', 'cost basis', 'amount paid', 'buy price',
    'acquisition cost', 'my cost'
  ],
  currentValue: [
    'value', 'est value', 'est val', 'estimated value', 'fmv', 'market value',
    'current val', 'current price', 'worth', 'retail', 'book value',
    'appraised value', 'valuation'
  ],
  notes: ['note', 'comment', 'comments', 'remarks', 'memo'],
  coinSet: ['set name', 'coin set', 'collection', 'album', 'folder'],
  metalContent: ['metal', 'metal type', 'precious metal'],
  // Grams only. Anything that names ounces is refused -- see the file header.
  weight: ['grams', 'weight grams', 'weight in grams', 'wt g', 'gross weight g'],
  soldPrice: [
    'sold', 'sold for', 'sold amount', 'sold value', 'sale price',
    'sale amount', 'realized', 'realized price'
  ],
  soldDate: ['date sold', 'date of sale', 'sale date', 'sold on']
};

/**
 * Normalised headings whose claim must be checked against the column's
 * values before it is allowed to stand.
 *
 * Exactly one entry, and it should stay that way unless another genuinely
 * ambiguous word turns up. The test is not "could this column be
 * misread?" -- almost any could -- but "does the heading itself fail to say
 * what kind of thing is underneath?". `Date` does. `Date Purchased`,
 * `Date Minted` and `Sale Date` do not, so reading their values would be
 * second-guessing a user who already told us.
 */
const VALUE_CHECKED_SYNONYMS: ReadonlySet<string> = new Set(['date']);

/** How sure we are about a match. Lower is more confident. */
const EXACT = 0;
const SYNONYM = 1;

/**
 * normalised header text -> { field, tier }, built once.
 *
 * Exact entries are written first and synonyms are only added where they do
 * not already exist, so a synonym can never displace a real key or label.
 */
const LOOKUP: ReadonlyMap<string, { field: string; tier: number }> = (() => {
  const lookup = new Map<string, { field: string; tier: number }>();

  for (const field of CSV_MAPPABLE_FIELDS) {
    if (!field.key) continue;
    for (const spelling of [field.key, field.label]) {
      const normalized = normalizeHeader(spelling);
      if (normalized) lookup.set(normalized, { field: field.key, tier: EXACT });
    }
  }

  for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const synonym of synonyms) {
      if (!lookup.has(synonym)) lookup.set(synonym, { field, tier: SYNONYM });
    }
  }

  return lookup;
})();

/**
 * The field one header on its own points at, or `undefined` when nothing in
 * the table is confident enough to say.
 *
 * Looks at the header in isolation, so it does not apply the
 * exact-beats-synonym or leave-a-tie-blank rules -- those need the whole row.
 * Use `mapHeadersToFields` for an actual import.
 */
export function matchHeaderToField(header: string): string | undefined {
  return LOOKUP.get(normalizeHeader(header))?.field;
}

/**
 * May an ambiguous date-ish heading keep its claim on `year`?
 *
 * Yes when the column's values read as coin years, and yes when there are
 * no values to read -- either because the caller supplied none (a
 * header-only caller, or a sheet whose rows are not loaded yet) or because
 * the column is empty. A column with nothing in it cannot put a wrong value
 * anywhere, so falling back to the numismatic reading of the heading is
 * harmless, and it keeps every existing header-only caller behaving exactly
 * as it did. No when the values are calendar dates, a mix, or unreadable.
 */
function columnLooksLikeCoinYears(
  columnValues: ColumnValueEvidence | undefined,
  header: string
): boolean {
  const samples = columnValues?.[header];
  if (!samples) return true;

  const shape = classifyColumnValues(samples);
  return shape === 'coin-year' || shape === 'no-evidence';
}

/**
 * Map a complete header row onto coin fields.
 *
 * Returns a dictionary keyed by the header text EXACTLY as it appeared in the
 * file, because that is what `CsvService.mapRowToCoin` and the mapping
 * dropdown both look up. A header that is not placed is ABSENT from the
 * result rather than present with an empty value: the template reads
 * `mapping[header] ?? ''` to show "(skip)", and the Weight (oz) guard in
 * export-import-round-trip.spec.ts asserts `toBeUndefined()`.
 *
 * Keying by text rather than by column index is also what makes a multi-sheet
 * workbook import work: two sheets that both have a `Cost` column share the
 * one decision, and a sheet whose columns are in a different order still maps
 * correctly because each sheet is applied against its own header array.
 *
 * @param columnValues optional sampled cells per column, keyed by the same
 *   header text. Used only to settle an ambiguous `Date` heading (see the
 *   file header). Already-sampled, not the whole column: build it with
 *   `textColumnSamples` / `mergeColumnSamples` from csv/date-column-shape.ts,
 *   or take it from `WorkbookSheet.valueSamples`. Omitting it gives exactly
 *   the header-only behaviour this function has always had.
 */
export function mapHeadersToFields(
  headers: string[],
  columnValues?: ColumnValueEvidence
): Record<string, string> {
  // Candidates per field, so the conflict rules below can see the whole row.
  const claims = new Map<string, { header: string; tier: number }[]>();

  const seenHeaders = new Set<string>();
  for (const header of headers) {
    if (seenHeaders.has(header)) continue;
    seenHeaders.add(header);

    const normalized = normalizeHeader(header);
    const match = LOOKUP.get(normalized);
    if (!match) continue;

    // The one value-aware rule. A `Date` column that holds calendar dates
    // withdraws its claim on `year` entirely rather than being re-aimed --
    // see the note at the top of this file. Withdrawing rather than
    // demoting also means a `Yr` column alongside it stops being a tie and
    // wins outright, which is the right answer and not a special case.
    if (match.tier === SYNONYM && VALUE_CHECKED_SYNONYMS.has(normalized)
        && !columnLooksLikeCoinYears(columnValues, header)) {
      continue;
    }

    const existing = claims.get(match.field);
    if (existing) existing.push({ header, tier: match.tier });
    else claims.set(match.field, [{ header, tier: match.tier }]);
  }

  const mapping: Record<string, string> = {};
  for (const [field, candidates] of claims) {
    const bestTier = Math.min(...candidates.map(candidate => candidate.tier));
    const winners = candidates.filter(candidate => candidate.tier === bestTier);
    // Exactly one most-confident claimant, or nobody gets it. See rule 3.
    if (winners.length === 1) mapping[winners[0].header] = field;
  }

  return mapping;
}
