 /*
  * Recognises other people's column headings (`Yr`, `Denom`, `MM`, `Cond`,
  * `TPG`, `Cert #`, `Cost`, `FMV`) for both the CSV and `.xlsx` imports. The
  * app's own export always matches exactly by key or label.
  *
  * A wrong guess is worse than a blank: a filled-in dropdown isn't re-read, so
  * a confident wrong mapping silently corrupts the import. Hence:
  *   1. No synonym for ambiguous words (`Price`, `Amount`, `Total` could be any
  *      of three money fields).
  *   2. Exact beats synonym: with both `Year` and `Date`, `Year` wins and
  *      `Date` is left blank.
  *   3. A tie leaves both blank (e.g. `Cost` and `Paid`).
  *
  * `normalizeHeader` keeps parenthesised text, so `Weight (g)` and
  * `Weight (oz)` stay distinct. The weight column is grams and `Weight (oz)`
  * must stay unmapped (see mappable-fields.ts).
  *
  * `Date` alone is the one heading checked against the column's values
  * (rules in csv/date-column-shape.ts): coin years keep the `year` mapping;
  * calendar dates withdraw the claim entirely rather than guessing
  * `purchaseDate`. Headings that say which date (`Date Purchased`,
  * `Date Sold`) are not value-checked.
  */

import { CSV_MAPPABLE_FIELDS } from './mappable-fields';
import { ColumnValueEvidence, classifyColumnValues } from './date-column-shape';

/**
 * Reduces a header to a comparable form: lower case, runs of non-alphanumerics
 * collapsed to one space, trimmed.
 *   `Cert #` -> `cert`, `Est. Value` -> `est value`, `PURCHASE_PRICE` -> `purchase price`
 * Digits are kept (`Weight (g)` -> `weight g`); a header of only punctuation
 * becomes '' and never matches.
 */
export function normalizeHeader(raw: string): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .toLowerCase()
    // Includes the non-breaking space common in Windows-1252 exports.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Alternative spellings by target field, stored already normalised (a spec
 * checks this). A field's own key and label are not repeated.
 *
 * Deliberately omitted:
 *   price / amount / total   ambiguous between three money fields
 *   weight (oz) / ozt        wrong unit
 *   source                   importable only so an export round-trips
 *   auction house            could be either counterparty
 *   consignor                put the coin into an auction; not who the buyer dealt with
 */
export const HEADER_SYNONYMS: Record<string, string[]> = {
  coinType: [
    'type', 'series', 'coin', 'coin name', 'coin description',
    'name', 'description', 'design'
  ],
  denomination: ['denom', 'face value', 'face', 'face amount'],
  // `Date` means the year struck in numismatic usage; acquisition dates are
  // spelled out (`Date Purchased`) under purchaseDate, so the two never compete.
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
    * Catalogue references. Not included: `cat` (already means Category), bare
    * `number`/`no`/`id` (could be cert or stock numbers), bare `ref` (often a
    * cert reference).
    */
  catalogRefs: [
    'catalog', 'catalogue', 'catalog no', 'catalogue no', 'catalog num',
    'catalogue num', 'catalog number', 'catalogue number', 'catalog ref', 'catalogue ref',
    'catalog references', 'catalogue references', 'catalog refs',
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
  /*
   * Who the coin was bought from. `seller` is safe: on an inventory row it is the
   * person bought from. Not included: `sold by` (reads like the sale side next to
   * `sold`/`sold for`), bare `from` (ambiguous), `auction house` and `consignor`.
   */
  purchasedFrom: [
    'dealer', 'dealer name', 'bought from', 'buy from', 'seller',
    'vendor', 'supplier', 'acquired from', 'source of purchase'
  ],
  notes: ['note', 'comment', 'comments', 'remarks', 'memo'],
  /*
   * Transaction notes: every spelling says it is about the deal. Bare `Memo`,
   * `Comment`, `Remarks` belong to `notes`, and nothing is listed in both (a spec
   * checks this). `purchase notes` and `sale notes` both land here, so a sheet
   * with both ties and leaves both for the user to place.
   */
  transactionNotes: [
    'transaction notes', 'transaction note', 'transaction memo',
    'transaction comments', 'deal notes', 'deal note',
    'purchase notes', 'sale notes'
  ],
  coinSet: ['set name', 'coin set', 'collection', 'album', 'folder'],
  metalContent: ['metal', 'metal type', 'precious metal'],
  // Grams only; anything naming ounces is refused.
  weight: ['grams', 'weight grams', 'weight in grams', 'wt g', 'gross weight g'],
  soldPrice: [
    'sold', 'sold for', 'sold amount', 'sold value', 'sale price',
    'sale amount', 'realized', 'realized price'
  ],
  soldDate: ['date sold', 'date of sale', 'sale date', 'sold on'],
  // Buyer = who the coin went to. Keep this list disjoint from purchasedFrom.
  soldTo: ['buyer', 'sold to buyer']
};

/**
 * Normalised headings whose claim must be checked against the column's values:
 * only those that don't say what kind of value they hold. Currently just `date`.
 */
const VALUE_CHECKED_SYNONYMS: ReadonlySet<string> = new Set(['date']);

/** Match confidence; lower is more confident. */
const EXACT = 0;
const SYNONYM = 1;

/**
 * Normalised header -> { field, tier }, built once. Exact entries go in first,
 * so a synonym never displaces a real key or label.
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
 * The field a single header points at, or undefined. Doesn't apply the
 * exact-beats-synonym or tie rules; use `mapHeadersToFields` for imports.
 */
export function matchHeaderToField(header: string): string | undefined {
  return LOOKUP.get(normalizeHeader(header))?.field;
}

/**
 * Whether an ambiguous date heading keeps its claim on `year`: yes if the
 * values read as coin years or there are no values, no for calendar dates,
 * mixed or unreadable values.
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
 * Maps a full header row onto coin fields. Keyed by header text exactly as in
 * the file (what `mapRowToCoin` and the dropdown look up). Unplaced headers are
 * absent from the result, not mapped to ''. Keying by text lets several sheets
 * share one mapping regardless of column order.
 *
 * @param columnValues optional sampled cells per column (from
 *   `textColumnSamples` / `mergeColumnSamples` or `WorkbookSheet.valueSamples`),
 *   used only to settle an ambiguous `Date` heading
 */
export function mapHeadersToFields(
  headers: string[],
  columnValues?: ColumnValueEvidence
): Record<string, string> {
  // Candidates per field, so the conflict rules can see the whole row.
  const claims = new Map<string, { header: string; tier: number }[]>();

  const seenHeaders = new Set<string>();
  for (const header of headers) {
    if (seenHeaders.has(header)) continue;
    seenHeaders.add(header);

    const normalized = normalizeHeader(header);
    const match = LOOKUP.get(normalized);
    if (!match) continue;

    // A `Date` column of calendar dates withdraws its claim on `year` entirely,
    // so a `Yr` column alongside it wins outright instead of tying.
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
    // Exactly one most-confident claimant, or nobody (rule 3).
    if (winners.length === 1) mapping[winners[0].header] = field;
  }

  return mapping;
}
