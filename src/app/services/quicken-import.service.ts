/**
 * Parses Quicken Interchange Format (QIF) investment-transaction exports into
 * coin import records.
 *
 * QIF investment fields are single-letter codes. Two read like something else:
 *   - `N` is the transaction action (Buy, Sell, ShrsIn, ReinvDiv, ...), not a name.
 *   - `Y` is the security name, which in a coin account holds the coin's description.
 *
 * Field lines used here:
 *   D  Date
 *   N  Action (Buy, Sell, ShrsIn, ShrsOut, ReinvDiv, ReinvLg, ReinvSh, ...)
 *   Y  Security name
 *   I  Price per share/unit
 *   Q  Quantity (shares/units)
 *   T  Transaction amount
 *   U  Transaction amount (alternate; seen in some Quicken exports)
 *   M  Memo
 *   L  Category / transfer account
 *   O  Commission
 *   C  Cleared status
 */
import { Injectable } from '@angular/core';
import { AmbiguousReading, QuickenImportRecord } from '../types/coin.model';
import { cacStickerFor } from '../types/cac-sticker';
// Proof detection is shared with the image matcher; don't duplicate it here.
import { detectStrike } from './image-matching/proof-strike';
// Maps pm-reference.ts's answer onto coin fields; shared with the Settings PM backfill.
import { composePmFields } from './pm-fill';
import { detectCountry, detectForeignDenomination } from './coin-countries';
// The 2-of-3 completeness rule, shared with the manual add-coin flow.
import { checkMainCoinDetails } from './coin-completeness';
// The shared "has this record been sold?" rule (CSV, Excel and QIF).
import { isSoldRecord } from './import-sold';
// Counterfeit words, imported as data only (see AUTHENTICITY_MARKER_PATTERNS).
import { COUNTERFEIT_MARKER_WORDS } from './image-matching/filename-vocabulary';

interface CoinTypeRange {
  min: number;
  max: number;
  coinType: string;
}

const COIN_TYPE_BY_DENOMINATION: Record<string, CoinTypeRange[]> = {
  '½¢': [
    { min: 1793, max: 1797, coinType: 'Flowing Hair Half Cent' },
    { min: 1800, max: 1808, coinType: 'Draped Bust Half Cent' },
    { min: 1809, max: 1836, coinType: 'Classic Head Half Cent' },
    { min: 1840, max: 1857, coinType: 'Braided Hair Half Cent' },
  ],
  '1¢': [
    { min: 1793, max: 1796, coinType: 'Flowing Hair' },
    { min: 1796, max: 1807, coinType: 'Draped Bust' },
    { min: 1808, max: 1814, coinType: 'Classic Head' },
    { min: 1816, max: 1857, coinType: 'Braided Hair' },
    { min: 1856, max: 1858, coinType: 'Flying Eagle' },
    { min: 1859, max: 1909, coinType: 'Indian Head' },
    { min: 1909, max: 2024, coinType: 'Lincoln' },
  ],
  '2¢': [
    { min: 1864, max: 1873, coinType: 'Two Cent' },
  ],
  '3CS': [
    { min: 1851, max: 1873, coinType: 'Three Cent Silver' },
  ],
  '3CN': [
    { min: 1865, max: 1889, coinType: 'Three Cent Nickel' },
  ],
  '5¢': [
    { min: 1794, max: 1805, coinType: 'Draped Bust Half Dime' },
    { min: 1829, max: 1837, coinType: 'Capped Bust Half Dime' },
    { min: 1837, max: 1873, coinType: 'Seated Liberty Half Dime' },
    { min: 1866, max: 1883, coinType: 'Shield' },
    { min: 1883, max: 1913, coinType: 'Liberty Head' },
    { min: 1913, max: 1938, coinType: 'Buffalo' },
    { min: 1938, max: 2024, coinType: 'Jefferson' },
  ],
  '10¢': [
    { min: 1796, max: 1807, coinType: 'Draped Bust' },
    { min: 1809, max: 1837, coinType: 'Capped Bust' },
    { min: 1837, max: 1891, coinType: 'Liberty Seated' },
    { min: 1892, max: 1916, coinType: 'Barber' },
    { min: 1916, max: 1945, coinType: 'Mercury' },
    { min: 1946, max: 2024, coinType: 'Roosevelt' },
  ],
  '20¢': [
    { min: 1875, max: 1878, coinType: 'Twenty Cent' },
  ],
  '25¢': [
    { min: 1796, max: 1807, coinType: 'Draped Bust' },
    { min: 1815, max: 1838, coinType: 'Capped Bust' },
    { min: 1838, max: 1891, coinType: 'Liberty Seated' },
    { min: 1892, max: 1916, coinType: 'Barber' },
    { min: 1916, max: 1930, coinType: 'Standing Liberty' },
    { min: 1932, max: 2024, coinType: 'Washington' },
  ],
  '50¢': [
    { min: 1794, max: 1795, coinType: 'Flowing Hair' },
    { min: 1796, max: 1807, coinType: 'Draped Bust' },
    { min: 1807, max: 1839, coinType: 'Capped Bust' },
    { min: 1839, max: 1891, coinType: 'Liberty Seated' },
    { min: 1892, max: 1915, coinType: 'Barber' },
    { min: 1916, max: 1947, coinType: 'Walking Liberty' },
    { min: 1948, max: 1963, coinType: 'Franklin' },
    { min: 1964, max: 2024, coinType: 'Kennedy' },
  ],
  '$1': [
    { min: 1794, max: 1795, coinType: 'Flowing Hair' },
    { min: 1795, max: 1804, coinType: 'Draped Bust' },
    { min: 1836, max: 1873, coinType: 'Liberty Seated' },
    { min: 1873, max: 1885, coinType: 'Trade' },
    { min: 1878, max: 1921, coinType: 'Morgan' },
    { min: 1921, max: 1935, coinType: 'Peace' },
    { min: 1971, max: 1978, coinType: 'Eisenhower' },
    { min: 1979, max: 1999, coinType: 'Susan B. Anthony' },
    { min: 2000, max: 2011, coinType: 'Sacagawea' },
  ],
  '$2.50': [
    { min: 1796, max: 1807, coinType: 'Draped Bust' },
    { min: 1808, max: 1834, coinType: 'Capped Bust' },
    // Classic Head: struck under the Act of 1834 (see the year bands in pm-reference.ts).
    { min: 1835, max: 1839, coinType: 'Classic Head' },
    { min: 1840, max: 1907, coinType: 'Coronet' },
    { min: 1908, max: 1929, coinType: 'Indian Head' },
  ],
  '$3': [
    { min: 1854, max: 1889, coinType: 'Indian Princess' },
  ],
  '$5': [
    { min: 1795, max: 1807, coinType: 'Draped Bust' },
    { min: 1807, max: 1834, coinType: 'Capped Bust' },
    // Classic Head, as for the quarter eagle above.
    { min: 1835, max: 1838, coinType: 'Classic Head' },
    { min: 1839, max: 1908, coinType: 'Coronet' },
    { min: 1908, max: 1929, coinType: 'Indian Head' },
  ],
  '$10': [
    { min: 1795, max: 1804, coinType: 'Draped Bust' },
    { min: 1838, max: 1907, coinType: 'Coronet' },
    { min: 1907, max: 1933, coinType: 'Indian Head' },
  ],
  '$20': [
    { min: 1849, max: 1907, coinType: 'Coronet' },
    { min: 1907, max: 1933, coinType: 'Saint-Gaudens' },
  ],
};

function inferCoinTypeByYear(denomination: string, year: number): string {
  if (denomination === '$1' && year >= 1878 && year <= 1921) {
    return 'Morgan';
  }

  const ranges = COIN_TYPE_BY_DENOMINATION[denomination];
  if (!ranges) return '';
  for (const range of ranges) {
    if (year >= range.min && year <= range.max) return range.coinType;
  }
  return '';
}

 /*
  * A bare "3¢" (or "3c", "three cent"): silver or nickel?
  *
  *     Three Cent Silver  "3CS", the trime  struck 1851-1873
  *     Three Cent Nickel  "3CN"             struck 1865-1889
  *
  *   year <= 1864   3CS, certain (the nickel didn't exist yet)
  *   year >= 1874   3CN, certain (the silver had ended)
  *   1865-1873      a guess, flagged as one
  *
  * Inside the overlap, scarcity decides: 3CS business strikes after 1862 were
  * tiny against millions of 3CN, but 3CS proofs continued normally, so a proof
  * means 3CS and anything else 3CN. A name with no year is treated as the
  * whole 1851-1889 span, with the same tie-break and flag.
  *
  * The guess and its reasoning are returned so the preview can show them and
  * the user can correct it. Keep the flag: without it a guess looks like a fact,
  * and the image matcher's own refusal path for this pair
  * (`describeUndecidedGeneric` in match-decider.ts) is lost.
  */

/** First year of the three-cent silver. */
const THREE_CENT_SILVER_FIRST_YEAR = 1851;
/** Last year of the three-cent silver. */
const THREE_CENT_SILVER_LAST_YEAR = 1873;
/** First year of the three-cent nickel (start of the overlap). */
const THREE_CENT_NICKEL_FIRST_YEAR = 1865;
/** Last year of the three-cent nickel. */
const THREE_CENT_NICKEL_LAST_YEAR = 1889;

/**
 * Decides what a bare three-cent reading means, and whether it was a guess.
 *
 * @param yearNum       the parsed year, or 0 when the name has none
 * @param securityName  the untouched security name, passed to `detectStrike`
 * @param grade         the grade parsed from that name ("PF64")
 * @returns the denomination, plus an `AmbiguousReading` only when the date
 *          didn't force the answer
 */
function resolveBareThreeCent(
  yearNum: number,
  securityName: string,
  grade: string
): { denomination: string; ambiguity?: AmbiguousReading } {
  // Certain: before the nickel existed.
  if (yearNum && yearNum < THREE_CENT_NICKEL_FIRST_YEAR) {
    return { denomination: '3CS' };
  }

  // Certain: after the silver ended.
  if (yearNum && yearNum > THREE_CENT_SILVER_LAST_YEAR) {
    return { denomination: '3CN' };
  }

  /* The overlap (or no date): scarcity rule, with proofs as the exception.
   * `detectStrike` returns 'business' when nothing is said, which is what this
   * rule wants for an unmarked name. */
  const isProof = detectStrike(securityName, grade) === 'proof';
  const chosen = isProof ? '3CS' : '3CN';

  const window = yearNum
    ? `${THREE_CENT_NICKEL_FIRST_YEAR}-${THREE_CENT_SILVER_LAST_YEAR}`
    : `${THREE_CENT_SILVER_FIRST_YEAR}-${THREE_CENT_NICKEL_LAST_YEAR}`;

  const situation = yearNum
    ? `${yearNum} falls in the ${window} overlap, when the three-cent silver and the three-cent nickel were both being struck`
    : `this name carries no year, and the three-cent silver and the three-cent nickel together cover ${window}`;

  const reasoning = isProof
    ? 'the name says proof, and three-cent silver proofs stayed plentiful to the end of the series, so the silver (3CS) was assumed'
    : 'nothing says proof, and three-cent silver business strikes after 1862 are very scarce while the nickel was struck in the millions, so the nickel (3CN) was assumed';

  return {
    denomination: chosen,
    ambiguity: {
      field: 'denomination',
      chosen,
      // Both members in series order, so the preview can offer the other one.
      alternatives: ['3CS', '3CN'],
      why: `${situation}; ${reasoning}. Check this one.`
    }
  };
}

/*
 * Grading companies that appear in security names, e.g. "1927 $20 - PCGS MS64",
 * "1875 20¢ - ANACS VG8", "1909 S-VDB 1¢ - PCGS/CAC AU58".
 *
 * Whole-token, case-insensitive regexes: the separators used (space, hyphen,
 * slash, backslash, parenthesis) are non-word characters, so "- PCGS", "-PCGS",
 * "PCGS/CAC" and "(CLEANED/PCGS)" match while "XPCGSY" doesn't. CACG is listed
 * first so "CACG MS65" is credited to CACG.
 */
const CERT_COMPANY_PATTERNS: readonly { token: string; pattern: RegExp }[] = [
  // CAC's own grading service (a slab), not the CAC sticker.
  { token: 'CACG',  pattern: /\bCACG\b/i },
  { token: 'PCGS',  pattern: /\bPCGS\b/i },
  { token: 'NGC',   pattern: /\bNGC\b/i },
  { token: 'ANACS', pattern: /\bANACS\b/i },
  { token: 'ICG',   pattern: /\bICG\b/i },
  { token: 'SEGS',  pattern: /\bSEGS\b/i },
  { token: 'NNC',   pattern: /\bNNC\b/i },
];

/*
 * The CAC sticker (`hasCacSticker`): CAC's sticker on another company's slab,
 * separate from the grading company. Written as "PCGS/CAC AU58", `CAC`,
 * `CAC'd`, `CACd`, `w/CAC`, `+CAC`, `(CAC)`, `CAC Gold` / `Gold CAC`.
 *
 * `CACG` is CAC's grading service, not a sticker: it sets `certCompany = 'CACG'`
 * and leaves `hasCacSticker` false. `\bCAC\b` can't match "CACG" (no boundary
 * before "G"); the `(?:'?d)?` group exists only for `CAC'd` / `CACd`. Widening
 * the pattern further risks matching CACG.
 */
const CAC_STICKER_PATTERN = /\bCAC(?:'?d)?\b/i;

/*
 * Authenticity wording: "FAKE", "Counterfeit", "Replica", "not genuine".
 *
 * Not an exclusion: a counterfeit the user owns imports like any other coin.
 * The wording is kept in Variety so the record differs from the genuine coin
 * of the same date and grade (e.g. "1855 3CS - VF - FAKE"). Variety, not Notes:
 * it describes the object, and Notes holds only the Quicken memo.
 *
 * The photo matcher uses the same words to match a fake photo only to a fake
 * record. The single words are reused from filename-vocabulary.ts; "not
 * genuine" is added here only.
 */
const AUTHENTICITY_MARKER_PATTERNS: readonly RegExp[] = [
  ...COUNTERFEIT_MARKER_WORDS.map(word => new RegExp(`\\b${word}\\b`, 'i')),
  /\bnot\s+genuine\b/i
];

/**
 * The authenticity wording in a security name, verbatim ("FAKE" stays "FAKE"),
 * or '' (the usual case).
 */
function detectAuthenticityWording(securityName: string): string {
  const found: string[] = [];
  for (const pattern of AUTHENTICITY_MARKER_PATTERNS) {
    const match = securityName.match(pattern);
    if (match) found.push(match[0]);
  }
  return found.join(' ');
}

/** Action codes for acquiring a position (a coin entering the collection). */
const ACQUISITION_ACTIONS = new Set([
  'buy',
  'buyx',
  'shrsin',
  'reinvdiv',
  'reinvlg',
  'reinvsh',
  'reinvint',
  'reinvmd',
  'reinvsg',
  'add',
  'cvrshrt',
  'margint'
]);

/** Action codes for disposing of a position (a coin leaving the collection). */
const DISPOSITION_ACTIONS = new Set(['sell', 'sellx', 'shrsout', 'shtsell', 'rtrncap']);

/** Cash-only transfers with no security; skipped silently. */
const CASH_TRANSFER_ACTIONS = new Set(['xin', 'xout']);

/*
 * Quicken's own transfer memo. Moving a holding between accounts makes Quicken
 * write `Xfr From: Misc. Coins` / `Xfr To: Odd Type Set`, which the user never
 * typed and doesn't want in Notes.
 *
 * Matched by shape, not subject: `Xfr`, `From` or `To`, a colon, from the start
 * of the memo. Memos that merely mention a transfer are kept (tests cover
 * "Opening transfer", "Transferred from the bank box", "Xfr paperwork mislaid",
 * "Sold to pay for the xfr to NGC").
 */
const QUICKEN_TRANSFER_MEMO = /^\s*xfr\s+(?:from|to)\s*:/i;

/** The memo for Notes: the user's own words, or '' for Quicken's transfer memo or no memo. */
export function memoForNotes(memo: string | undefined): string {
  const text = (memo ?? '').trim();
  if (!text) return '';
  return QUICKEN_TRANSFER_MEMO.test(text) ? '' : text;
}

/**
 * Whether this block stated a money amount. `resolveAmount` answers 0 when none
 * was stated, which is wrong for a sale price (0 counts as a real price in the
 * sold rule), so an amount-less transfer must leave it unset. Uses the same
 * sources as `resolveAmount`.
 */
function statesAmount(fields: ParsedInvestmentFields): boolean {
  if (fields.amount !== undefined || fields.altAmount !== undefined) return true;
  return fields.price !== undefined && fields.quantity !== undefined;
}

/* The 2-of-3 rule lives in coin-completeness.ts (shared with "Add coin");
 * re-exported here for existing importers. */
export {
  MINIMUM_MAIN_DETAILS,
  isCoinDetailPresent,
  checkMainCoinDetails
} from './coin-completeness';
export type { CoinDetailCheck } from './coin-completeness';

/**
 * A coin that parsed but lacks enough detail to import. Shown to the user as an
 * exception, never silently dropped.
 */
export interface QuickenRejectedRecord {
  /** The raw `Y` (security name) line. */
  securityName: string;
  /** What could be parsed, so the user can judge or override. */
  record: QuickenImportRecord;
  present: string[];
  missing: string[];
  reason: string;
}

/** Options for one parse (an object rather than positional booleans). */
export interface QuickenParseOptions {
  /**
   * Leave out sold coins.
   *
   * "Sold" follows the shared rule (sold date, sold price or buyer;
   * import-sold.ts). A QIF has none of those columns, so a net quantity <= 0
   * (Buy then Sell / SellX / ShrsOut) detects a disposal, and the disposal's date
   * and proceeds are written onto the record.
   *
   * Default false: sold coins are imported too, so past holdings can be reported
   * on. When on, held-back coins are reported in `skippedRecords`.
   */
  excludeSold?: boolean;
}

export interface QuickenParseResult {
  importedRecords: QuickenImportRecord[];
  /**
   * Coins held out by `excludeSold`; always empty when it is off. For the sold
   * coins themselves see `soldSecurityNames`.
   */
  skippedRecords: QuickenImportRecord[];
  /** Coins failing the 2-of-3 main-detail rule. */
  rejectedRecords: QuickenRejectedRecord[];
  /**
   * Security names of every coin whose net quantity is <= 0 (sold or transferred
   * out). Reported regardless of `excludeSold`, so the caller can count what the
   * option hides, or mark imported coins as Sold rather than Owned.
   */
  soldSecurityNames: string[];
  warnings: string[];
  accounts: string[];
}

interface ParsedInvestmentFields {
  date?: string;
  action?: string;
  security?: string;
  price?: string;
  quantity?: string;
  amount?: string;
  altAmount?: string;
  memo?: string;
  commission?: string;
}

@Injectable({ providedIn: 'root' })
export class QuickenImportService {
  /**
   * Parses raw QIF text into coin import records.
   *
   * Acquisitions and dispositions are both tracked to get each security's net
   * holding. By default sold coins still import; their names are reported in
   * `soldSecurityNames`. With `{ excludeSold: true }` they go to `skippedRecords`.
   *
   * @param qifText raw contents of a `.qif` export
   * @param selectedAccounts when given, only transactions under a matching
   *   `!Account` block are imported; all account names are still returned in
   *   `accounts` for the account picker
   * @param denominationChoices the user's answers to readings flagged as guesses,
   *   keyed on the raw security name (see `AmbiguousReading` in coin.model.ts).
   *   Applied during parsing because coin type and all alloy/weight fields derive
   *   from the denomination. A choice is used only for a security whose reading was
   *   flagged and only if it is one of the offered values; stale entries are ignored.
   * @param options see `QuickenParseOptions`; defaults import everything
   */
  parse(
    qifText: string,
    selectedAccounts?: string | string[],
    denominationChoices?: Readonly<Record<string, string>>,
    options?: QuickenParseOptions
  ): QuickenParseResult {
    const excludeSold = options?.excludeSold === true;
    const warnings: string[] = [];
    const accounts = new Set<string>();
    let currentAccount: string | null = null;

    // Security name -> { qty, latest record and date, and the latest disposal's
    // date and proceeds }. The disposal lets a QIF sale satisfy the same sold rule
    // as a CSV row. Net qty > 0 means still held.
    const netQuantityMap = new Map<
      string,
      {
        qty: number;
        latestRecord: QuickenImportRecord | null;
        latestDate: string;
        /** Date of the latest disposal; '' when none. */
        soldDate: string;
        /**
         * Proceeds of that disposal; undefined when the block stated no amount (e.g. a
         * `ShrsOut` transfer). 0 would claim the coin was given away.
         */
        soldPrice: number | undefined;
      }
    >();

    const selected = Array.isArray(selectedAccounts)
      ? selectedAccounts.map((account) => account.trim()).filter(Boolean)
      : selectedAccounts
        ? [selectedAccounts.trim()].filter(Boolean)
        : [];

    const blocks = qifText
      .split(/^\^\s*$/m)
      .map((block) => block.trim())
      .filter(Boolean);

    for (const block of blocks) {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const firstLine = lines[0] ?? '';

      if (firstLine.startsWith('!Account')) {
        currentAccount = this.extractAccountName(lines);
        accounts.add(currentAccount);
        continue;
      }

      // Price history isn't needed for an inventory import.
      if (firstLine.startsWith('!Type:Prices')) {
        continue;
      }

      // A bare header line (e.g. `!Type:Invst`) carries no transaction data.
      if (firstLine.startsWith('!Type') && lines.length === 1) {
        continue;
      }

      const fields = this.parseInvestmentFields(lines);
      if (!fields) {
        continue;
      }

      if (selected.length > 0 && (!currentAccount || !selected.includes(currentAccount))) {
        continue;
      }

      if (!fields.security) {
        continue;
      }

      const actionKey = (fields.action ?? '').toLowerCase();

      // Skip cash-only transfers.
      if (CASH_TRANSFER_ACTIONS.has(actionKey)) {
        continue;
      }

      // The user's answer to a flagged guess for this security goes in too, so coin
      // type and alloy derive from the corrected denomination.
      const attrs = this.parseAttributes(
        fields.security,
        denominationChoices?.[fields.security]
      );
      const purchasePrice = this.resolveAmount(fields);
      if (purchasePrice < 0) {
        warnings.push(
          `Ignored "${fields.security}" -- negative value detected (${purchasePrice.toFixed(2)}); it will not be imported.`
        );
        continue;
      }

      // No completeness check here; it happens once, in the final assembly loop.

      const purchaseDate = fields.date ? this.normalizeDate(fields.date) : '';

       /*
        * The alloy follows from country, denomination and year (a 1964 quarter is 90%
        * silver, a 1965 one has none); rules in pm-reference.ts, mapped by
        * `composePmFields` (also used by the Settings backfill). `attrs.metalHint`
        * settles face values struck in two metals (the 1849-1889 "$1") when the name
        * says "Gold" or "G$1"; otherwise those fields stay blank.
        */
      const alloy = composePmFields(
        attrs.denomination,
        attrs.year,
        attrs.country,
        attrs.metalHint,
         // Coin type is extra evidence for the coarse metal fallback ("Gold Eagle",
         // "Saint-Gaudens") when the table has no row; it can add Metal Content only.
        { coinType: attrs.coinType }
      );

      const record: QuickenImportRecord = {
        id: crypto.randomUUID(),
        denomination: attrs.denomination,
        year: attrs.year,
        coinType: attrs.coinType,
        grade: attrs.grade,
        // From the same security name. `hasCacSticker` is always a boolean (BIT NOT NULL column).
        certCompany: attrs.certCompany,
        hasCacSticker: attrs.hasCacSticker,
        mintMark: attrs.mintMark,
        variety: attrs.variety,
        account: currentAccount ?? 'Unassigned',
        purchaseDate,
        purchasePrice,
        currentValue: purchasePrice,
        // From the security name when it names a country, else the default (see parseAttributes).
        country: attrs.country,
        /* Notes is the Quicken memo (`M`) only: no fallback or synthesis, so a block
         * without a memo gives blank Notes. `memoForNotes` drops Quicken's generated
         * `Xfr From/To:` memo (see QUICKEN_TRANSFER_MEMO). Authenticity wording goes to
         * Variety, not here. */
        notes: memoForNotes(fields.memo),
         /* `purchasedFrom`, `soldTo` and `transactionNotes` are deliberately not set.
          * The only counterparty line in a QIF investment block is `P`, the payee, which
          * Quicken routinely fills with the account name ("Misc. Coins"), and account
          * names can't be reliably filtered out (a one-account export doesn't declare
          * the others). A wrong name is worse than a blank. The test corpus invents
          * dealer payees, so it can't judge this rule. `transactionNotes`: the memo
          * already goes to `notes`. `parseInvestmentFields` has no `case 'P'`, so the
          * payee is never read (see quicken-payee-not-a-dealer.spec.ts). */
        source: 'quicken',
        // All five alloy/weight fields come from the one lookup: all filled, only
        // `metalContent` (coarse fallback), or all undefined.
        metalContent: alloy?.metalContent,
        composition: alloy?.composition,
        pmWeightGrams: alloy?.pmWeightGrams,
        pmPercent: alloy?.pmPercent,
        // Gross weight from the same reference row as the other four.
        weight: alloy?.weight,
        /* Kept only as a preview key that survives a re-parse (`id` is a new UUID each
         * time); never stored on CoinRecord. */
        securityName: fields.security,
        /* Undefined (not []) on most coins, so `record.ambiguities?.length` is honest.
         * An ambiguous reading is a flag, not a rejection (see `AmbiguousReading`). */
        ambiguities: attrs.ambiguities.length > 0 ? attrs.ambiguities : undefined
      };

      // Net quantity: acquisitions +1, dispositions -1.
      const existing = netQuantityMap.get(fields.security) ?? {
        qty: 0,
        latestRecord: null,
        latestDate: '',
        soldDate: '',
        soldPrice: undefined as number | undefined
      };

      if (DISPOSITION_ACTIONS.has(actionKey)) {
        // Disposition: on a Sell block this block's date and amount are the sale's.
        existing.qty -= 1;
        // The latest disposal wins; `>=` so same-day disposals settle on the last in the file.
        if (purchaseDate >= existing.soldDate) {
          existing.soldDate = purchaseDate;
          /* No amount means no price, not a price of 0. A `ShrsOut` transfer has no
           * `T`/`U`/`I` line; 0 would count as a real price in import-sold.ts. */
          existing.soldPrice = statesAmount(fields) ? purchasePrice : undefined;
        }
        netQuantityMap.set(fields.security, existing);
      } else if (ACQUISITION_ACTIONS.has(actionKey)) {
        // Acquisition: increment and keep the newest record.
        existing.qty += 1;
        if (purchaseDate >= existing.latestDate) {
          existing.latestRecord = record;
          existing.latestDate = purchaseDate;
        }
        netQuantityMap.set(fields.security, existing);
      } else {
        // Unrecognised action: treated as an acquisition, with a warning.
        warnings.push(
          `Imported "${fields.security}" with an unrecognized action code (${fields.action}); please verify the cost basis.`
        );
        existing.qty += 1;
        if (purchaseDate >= existing.latestDate) {
          existing.latestRecord = record;
          existing.latestDate = purchaseDate;
        }
        netQuantityMap.set(fields.security, existing);
      }
    }

    // Every imported record passes through this loop, the one place the rules apply:
    //   1. Sold, only if requested: a coin with qty <= 0 imports by default; its
    //      name goes in `soldSecurityNames` and its sold date/price are recorded.
    //   2. 2-of-3 rule: at least two of Year / Coin Type / Denomination, else it goes
    //      to `rejectedRecords` (shown to the user, optionally overridable).
    const importedRecords: QuickenImportRecord[] = [];
    const skippedRecords: QuickenImportRecord[] = [];
    const rejectedRecords: QuickenRejectedRecord[] = [];
    const soldSecurityNames: string[] = [];

    for (const [securityName, data] of netQuantityMap.entries()) {
      const record = data.latestRecord;
      if (!record) {
        // Only dispositions were seen; there is no acquisition to build a record from.
        continue;
      }

      /* Gate 1, part one: a QIF has no "sold" flag, so net quantity <= 0 detects a
       * disposal. The sale's date and proceeds (when stated) are written onto the
       * record so the shared sold rule can read them. */
      const soldByNetQuantity = data.qty <= 0;
      if (soldByNetQuantity) {
        soldSecurityNames.push(securityName);
        if (data.soldDate) record.soldDate = data.soldDate;
        if (data.soldPrice !== undefined) record.soldPrice = data.soldPrice;
      }

      /* Gate 1, part two: `isSoldRecord` is the shared rule used by CSV and Excel too.
       * `soldByNetQuantity` is kept alongside it because a disposal without a `D`
       * line leaves nothing for the rule to read. */
      if (excludeSold && (soldByNetQuantity || isSoldRecord(record))) {
        skippedRecords.push(record);
        continue;
      }

      // Gate 2: the 2-of-3 rule.
      const detailCheck = checkMainCoinDetails(record);
      if (!detailCheck.passes) {
        rejectedRecords.push({
          securityName,
          record,
          present: detailCheck.present,
          missing: detailCheck.missing,
          reason: detailCheck.reason
        });
        continue;
      }

      importedRecords.push(record);
    }

    return {
      importedRecords,
      skippedRecords,
      rejectedRecords,
      soldSecurityNames,
      warnings,
      accounts: [...accounts]
    };
  }

  /** The account name from an `!Account` block's `N` line. */
  private extractAccountName(lines: string[]): string {
    const nameLine = lines.find((line) => line.startsWith('N'));
    return nameLine?.slice(1).trim() || 'Unknown Account';
  }

  /**
   * Extracts the known investment field codes from a transaction block; null when
   * there are none (not an investment transaction this parser understands).
   */
  private parseInvestmentFields(lines: string[]): ParsedInvestmentFields | null {
    const isInvestmentBlock = lines.some((line) => /^[DNYIQTUMO]/.test(line));
    if (!isInvestmentBlock) {
      return null;
    }

    const fields: ParsedInvestmentFields = {};

    for (const line of lines) {
      if (line.startsWith('!')) {
        continue;
      }

      const prefix = line[0];
      const value = line.slice(1).trim();

      switch (prefix) {
        case 'D':
          fields.date = value;
          break;
        case 'N':
          fields.action = value;
          break;
        case 'Y':
          fields.security = value;
          break;
        case 'I':
          fields.price = value;
          break;
        case 'Q':
          fields.quantity = value;
          break;
        case 'T':
          fields.amount = value;
          break;
        case 'U':
          fields.altAmount = value;
          break;
        case 'M':
          fields.memo = value;
          break;
        case 'O':
          fields.commission = value;
          break;
        default:
          break;
      }
    }

    return fields;
  }

  /**
   * The transaction's dollar amount: an explicit `T`/`U` field, else price x
   * quantity + commission.
   */
  private resolveAmount(fields: ParsedInvestmentFields): number {
    const amountText = fields.amount ?? fields.altAmount;
    if (amountText !== undefined) {
      return this.parseAmount(amountText);
    }

    if (fields.price !== undefined && fields.quantity !== undefined) {
      const commission = fields.commission !== undefined ? this.parseAmount(fields.commission) : 0;
      return this.parseAmount(fields.price) * this.parseAmount(fields.quantity) + commission;
    }

    return 0;
  }

  /** Parses a QIF number, tolerating thousands separators. */
  private parseAmount(value: string): number {
    const cleaned = value.replace(/,/g, '').trim();
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Normalises a QIF date (`M/D/YYYY`, `M/D'YY`, `MM-DD-YYYY`, ...) to ISO
   * `YYYY-MM-DD`; unrecognised shapes are returned unchanged.
   */
  private normalizeDate(value: string): string {
    const cleaned = value.replace(/'/g, '/').trim();
    const parts = cleaned.split(/[/-]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length !== 3) {
      return value;
    }

    let month: string;
    let day: string;
    let year: string;

    if (/^\d{4}$/.test(parts[0])) {
      // Already ISO (`YYYY-MM-DD`), as some exporters and test fixtures write; reading
      // it as M/D/Y would produce dates like "2001-2024-02".
      [year, month, day] = parts;
    } else {
      // Quicken's native order: M/D/Y.
      [month, day, year] = parts;
    }

    if (year.length <= 2) {
      // Two-digit years: 00-50 -> 2000s, 51-99 -> 1900s.
      const yearNumber = Number.parseInt(year, 10);
      if (Number.isNaN(yearNumber)) return value;
      year = String(yearNumber <= 50 ? 2000 + yearNumber : 1900 + yearNumber);
    }

    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (
      year.length !== 4 ||
      !Number.isInteger(monthNumber) ||
      !Number.isInteger(dayNumber) ||
      monthNumber < 1 ||
      monthNumber > 12 ||
      dayNumber < 1 ||
      dayNumber > 31
    ) {
      // Unrecognised shape: return the original text.
      return value;
    }

    return `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
  }

  /**
   * Parses structured attributes from a Quicken security name, e.g.
   *   "1875S 20c-XF"
   *   "1921 Morgan Dollar MS63"
   *   "1916D Mercury Dime VF/XF"
   *
   * - Year: leading 4 digits ("1875"), with an overdate suffix ("1862/1")
   * - Mint mark: letters right after the year ("1875S" -> "S")
   * - Grade: VF, EF, XF, AU, MS, PR, PF, Unc, AG, G, VG, F, with numbers and
   *   modifiers (AU58, MS63, CH+AU, VF/EF) and designations (PF65RB)
   * - Cert company: whole-token PCGS, NGC, ANACS, ICG, SEGS, CACG, NNC
   * - CAC sticker: whole-token "CAC" and variants (not CACG)
   * - Denomination: to symbolic form (3CS, 20c -> 20¢, half -> 50¢, ...)
   * - Variety: explicit keywords only (Type I, Type II, DDO, DDR), plus
   *   authenticity wording
   * - Coin type: from name keywords or denomination + year
   *
   * Every rule reads the original `securityName`; nothing is stripped as it goes,
   * so "PCGS MS63" yields both certCompany "PCGS" and grade "MS63".
   *
   * @param securityName the `Y` field
   * @param chosenDenomination the user's answer to a previously flagged guess;
   *   applied after the denomination ladder and before the coin type, and ignored
   *   unless this name produced a denomination ambiguity offering that value
   */
  private parseAttributes(securityName: string, chosenDenomination?: string): {
    year: string;
    mintMark: string;
    grade: string;
    denomination: string;
    variety: string;
    coinType: string;
    certCompany: string;
    hasCacSticker: boolean;
    country: string;
    metalHint: string;
    /** Readings this parse wasn't sure about; empty for nearly every name (see `AmbiguousReading`). */
    ambiguities: AmbiguousReading[];
  } {
    let year = '';
    let mintMark = '';
    let grade = '';
    let denomination = '';
    let variety = '';
    let coinType = '';
    let certCompany = '';
    const ambiguities: AmbiguousReading[] = [];

    // Year, including an overdate suffix (e.g. 1862/1).
    const yearMatch = securityName.match(/^(\d{4}(?:\/\d{1,2})?)/);
    if (yearMatch) {
      year = yearMatch[1];
    }

    // Mint mark right after the year, with or without a hyphen (S, D, O, CC, C, W, P...).
    const mintMarkMatch = securityName.match(/^(?:\d{4}(?:\/\d{1,2})?)[-\s]?([A-Z]{1,2})(?:\b|[-\s])/i);
    if (mintMarkMatch) {
      const discovered = mintMarkMatch[1].toUpperCase();
      if (['P', 'D', 'S', 'O', 'C', 'CC', 'W', 'MM'].includes(discovered)) {
        mintMark = discovered;
      }
    }

    // Grade (after "-" or a space), in two passes:
    //   Pass 1: a numeric grade with a designation suffix: PF65RB, PF64Cameo,
    //     PF65 Cameo, PF69DCAM, MS64DMPL, MS70-FS, MS64+. The trailing `(?![A-Z0-9])`
    //     must not become `\b`: there is no word boundary inside "PF65RB", and `\b`
    //     fails after a "+".
    //   Pass 2: plain grades (XF, AU53, VF/EF, CH+AU), only if pass 1 finds nothing.
    const GRADE_CORE =
      String.raw`(?:CH\+)?(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|AG|VG|F|G)` +
      String.raw`(?:\/(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|AG|VG|F|G))?`;

    // Standard designations, longer alternatives first (CAMEO before CAM, DMPL before PL):
    //   Colour (copper):  RD red, RB red-brown, BN brown
    //   Proof surfaces:   CAMEO/CAM cameo, DCAM deep cameo, UCAM ultra cameo
    //   Mirror:           DMPL deep mirror prooflike, DPL, PL prooflike
    //   Strike:           FS full steps, FB full bands, FH full head,
    //                     FBL full bell lines, FT full torch
    const GRADE_DESIGNATIONS =
      'DCAM|UCAM|CAMEO|CAM|DMPL|DPL|PL|RD|RB|BN|FBL|FS|FB|FH|FT';

    const gradeWithDesignation = securityName.match(
      new RegExp(
        `[-\\s](${GRADE_CORE}\\d{1,2}(?:[-\\s]?(?:${GRADE_DESIGNATIONS}))?\\+?)(?![A-Z0-9])`,
        'i'
      )
    );

    const gradeMatch = gradeWithDesignation ?? securityName.match(
      new RegExp(`[-\\s](${GRADE_CORE}(?:\\d{1,2})?)\\b`, 'i')
    );

    if (gradeMatch) {
      // "PF65 Cameo" and "PF65Cameo" normalise to the same value.
      grade = gradeMatch[1].toUpperCase().replace(/[-\s]+/g, '');
    }

    // Cert company: the first whole-token hit, stored as the bare upper-case token.
    // (The editor's input is capped at 10 characters.) Reads the untouched name, so
    // "PCGS MS63", "NGC PF65RB" etc. keep their already-extracted grade.
    for (const candidate of CERT_COMPANY_PATTERNS) {
      if (candidate.pattern.test(securityName)) {
        certCompany = candidate.token;
        break;
      }
    }

    // CAC sticker flag (not CACG; see CAC_STICKER_PATTERN). Always a boolean: the
    // column is BIT NOT NULL DEFAULT 0.
    const hasCacSticker = CAC_STICKER_PATTERN.test(securityName);

    // Variety: explicit keywords only.
    if (/Type\s*I\b/i.test(securityName)) {
      variety = 'Type I';
    } else if (/Type\s*II\b/i.test(securityName)) {
      variety = 'Type II';
    } else if (/\bDDO\b/i.test(securityName)) {
      variety = 'DDO';
    } else if (/\bDDR\b/i.test(securityName)) {
      variety = 'DDR';
    }

    /* Authenticity wording is appended to the variety, not a replacement:
     * "1861 3CS DDO - FAKE" is a doubled-die counterfeit and both facts are kept.
     * See AUTHENTICITY_MARKER_PATTERNS. */
    const authenticity = detectAuthenticityWording(securityName);
    if (authenticity) {
      variety = variety ? `${variety} ${authenticity}` : authenticity;
    }

    /* Country: named in the text, or implied by a single-issuer currency unit
     * ("Soles" -> Peru); otherwise United States. Don't hard-code the default in
     * place of the lookup, or "1969 Peru 100 Soles" fails the 2-of-3 rule. */
    const country = detectCountry(securityName) || 'United States';

    /*
     * Metal hint: some face values existed in two metals at once (the 1849-1889
     * "$1": 26.73 g silver and 1.67 g gold), and pm-reference.ts won't guess. Forms
     * seen in security names:
     *     "1849-O $1 Gold - ANACS XF45"       the word
     *     "1855 G$1 - PCGS/CAC AU50"          "G$" shorthand
     *     "1873 Open 3 G$2.50 - ANACS AU53"   ditto
     * "CAC Gold" / "Gold CAC" is CAC's gold sticker tier, not the metal, and appears
     * on silver coins ("1875 20¢ - PCGS XF40 CAC Gold"), so it is removed first.
     */
    const metalHint = this.detectMetalHint(securityName);

    // Denomination, converted to symbolic form.
    const lowerName = securityName.toLowerCase();
    const yearNum = parseInt(year, 10) || 0;

    /* Foreign denomination ("100 Soles", "20 Francs"): read first but used ahead of
     * the US table only for non-US coins. */
    const foreign = detectForeignDenomination(securityName);

    /* Israeli sheqalim written as a bare "S" ("1982 Israel Qumran 5S - ANACS
     * PF69DCAM"). The general reader in coin-countries.ts requires a separator,
     * since a letter glued to a number looks like a grade suffix or mint mark, so
     * this is a narrow rule that also requires the name to say Israel. */
    const sheqalim = /\bisrael/i.test(securityName)
      ? /\b(\d{1,4})\s?S\b/.exec(securityName)
      : null;

    // A non-US coin with a "<number> <currency unit>" reading is settled here.
    if (foreign && country !== 'United States') {
      denomination = foreign.denomination;
    // Guarded on Israel (see the `sheqalim` read above).
    } else if (sheqalim) {
      denomination = `${sheqalim[1]} Sheqalim`;
    // Explicit silver or nickel three-cent (words or abbreviations).
    } else if (/three[\s-]?cent[\s-]?silver|3cs\b/i.test(lowerName)) {
      denomination = '3CS';
    } else if (/three[\s-]?cent[\s-]?nickel|3cn\b/i.test(lowerName)) {
      denomination = '3CN';
    /* A bare 3¢ / "three cent" / "3c": `resolveBareThreeCent` returns the reading
     * and, when it was a guess, the flag. */
    } else if (/3¢/.test(securityName) || /three[\s-]?cent/i.test(lowerName) || /\b3c\b/.test(lowerName)) {
      const threeCent = resolveBareThreeCent(yearNum, securityName, grade);
      denomination = threeCent.denomination;
      if (threeCent.ambiguity) {
        ambiguities.push(threeCent.ambiguity);
      }
    /*
     * Symbol denominations (½¢, ½10¢, 1¢, 2¢, 5¢, 10¢, 20¢, 25¢, 50¢).
     *
     * Order matters: this ladder uses substring tests, so the longest spelling must
     * come first. "1868 25¢" contains "5¢" (a quarter would import as a five-cent
     * piece), and "1860 ½10¢" contains "10¢" (a half dime would import as a dime).
     * Put any new row above every spelling it contains.
     */
    } else if (/½¢|1\/2¢/.test(securityName) || /half[\s-]?cent/i.test(lowerName)) {
      denomination = '½¢';
    /* The half dime, written "½10¢" (or 5¢); must precede /10¢/. The matcher's
     * denomination-units.ts has the same ordering rule. */
    } else if (/½\s*10¢|1\/2\s*10¢/.test(securityName) || /half[\s-]?dime/i.test(lowerName)) {
      denomination = '5¢';
    /* ATB ("America the Beautiful"): every coin is a quarter, including the 5 oz
     * silver pieces ("2011 5oz. ATB Vicksburg"). Case-sensitive initialism. */
    } else if (/\bATB\b/.test(securityName)) {
      denomination = '25¢';
    /* 25¢ above 5¢, because "25¢" contains "5¢". */
    } else if (/25¢/.test(securityName) || /\bquarter\b/i.test(lowerName) || /\b25c\b/.test(lowerName)) {
      denomination = '25¢';
    } else if (/5¢/.test(securityName) || /\bnickel\b/i.test(lowerName)) {
      denomination = '5¢';
    } else if (/10¢/.test(securityName) || /\bdime\b/i.test(lowerName)) {
      denomination = '10¢';
    } else if (/50¢/.test(securityName) || /\b50c\b/.test(lowerName) || /half[\s-]?dollar/i.test(lowerName)) {
      denomination = '50¢';
    } else if (/20¢/.test(securityName) || /twenty[\s-]?cent/i.test(lowerName) || /\b20c\b/.test(lowerName)) {
      denomination = '20¢';
    } else if (/2¢/.test(securityName) || /two[\s-]?cent/i.test(lowerName) || /\b2c\b/.test(lowerName)) {
      denomination = '2¢';
    } else if (/1¢/.test(securityName) || /\bcent\b|\bpenny\b/i.test(lowerName)) {
      denomination = '1¢';
    // Dollar-based denominations
    } else if (/\b8\s*real/i.test(lowerName)) {
      denomination = '8 Reales';
    /*
     * The Eagles: a family, decided by metal and year:
     *   Silver Eagle       $1     bullion
     *   Quarter Eagle      $2.50  gold
     *   Half Eagle         $5     gold
     *   Eagle              $10    gold, classic series
     *   Double Eagle       $20    gold
     *   modern Gold Eagle  $50    one-ounce bullion, since 1986
     * Silver is tested first (a bare "eagle" test would make "Proof Silver Eagle" a
     * $10 gold piece), then the modern gold year rule, then the classic $10.
     */
    /* A multi-coin set gets no denomination: "1987 2-coin Proof American Gold Eagle
     * Set" is a $50 and a $25. It needs its own branch assigning '' (skipping would
     * fall through to the $10 test), and blank sends it to the exceptions list. */
    } else if (/gold\s*eagle/i.test(securityName) && /\bsets?\b/i.test(securityName)) {
      denomination = '';
    // Silver Eagle / ASE is the $1 bullion coin. 'ASE' is case-sensitive (an
    // initialism; lowercase "ase" is usually part of a word).
    } else if (/silver\s*eagle/i.test(securityName) || /\bASE\b/.test(securityName)) {
      denomination = '$1';
    } else if (/double\s*eagle|[\$£]20\b/i.test(securityName)) {
      denomination = '$20';
    /* The one-ounce Gold Eagle is a $50, struck only since 1986. Sets were handled above. */
    } else if (/gold\s*eagle/i.test(securityName) && yearNum >= 1986) {
      denomination = '$50';
    } else if (/\beagle\b|[\$£]10\b/i.test(securityName)) {
      denomination = '$10';
    /* $50 and $25 (modern bullion face values) above $5 and $2.50, longest first. */
    } else if (/[\$£]50\b/.test(securityName)) {
      denomination = '$50';
    } else if (/[\$£]25\b/.test(securityName)) {
      denomination = '$25';
    } else if (/[\$£]5\b/.test(securityName)) {
      denomination = '$5';
    } else if (/[\$£]3\b/.test(securityName)) {
      denomination = '$3';
    } else if (/[\$£]2\.50\b/.test(securityName)) {
      denomination = '$2.50';
    /* SBA (Susan B. Anthony dollar), used alone ("1999 SBA - PF"). Case-sensitive like ASE. */
    } else if (/\bSBA\b/.test(securityName)) {
      denomination = '$1';
    } else if (/[\$£]1\b|\bdollar\b|\bpound\b|\bsovereign\b/i.test(securityName)) {
      denomination = '$1';
    } else if (/\bcrown\b/i.test(lowerName)) {
      denomination = '5s';
    } else if (/\bshilling\b/i.test(lowerName)) {
      denomination = '1s';
    } else if (/\bpence\b|\bpenny\b.*\b(?:british|uk|gb)\b|\b(?:british|uk|gb)\b.*\bpenny\b/i.test(lowerName)) {
      denomination = '1d';
    } else if (foreign) {
      // Fallback: the US table found nothing but the name has a number bound to a
      // currency unit, e.g. "1915 20 Francs" (country left blank: several issuers).
      denomination = foreign.denomination;
    } else {
      denomination = '';
    }

    /*
     * The user's correction to a flagged guess. Applied here, after the ladder and
     * before anything derived from the denomination (coin type here, alloy fields
     * in `parse`), so those follow the corrected value.
     * Accepted only when (a) this name produced a denomination ambiguity and
     * (b) the value is one of the parser's listed alternatives, so a stale or
     * hand-edited entry can't set an arbitrary denomination.
     */
    if (chosenDenomination) {
      const flagged = ambiguities.find(
        a => a.field === 'denomination' && a.alternatives.includes(chosenDenomination)
      );
      if (flagged) {
        denomination = chosenDenomination;
        // The flag still records the ambiguity and candidates; `chosen` says what was applied.
        flagged.chosen = chosenDenomination;
      }
    }

    // Coin type from name keywords or denomination + year. `metalHint` matters: a
    // "$1" that says Gold is a Gold Dollar, not a silver dollar.
    coinType = this.inferCoinType(securityName, denomination, year, metalHint);

    // certCompany and hasCacSticker are not part of the 2-of-3 rule: a slab label
    // says who graded the coin, not what it is.
    return {
      year, mintMark, grade, denomination, variety, coinType, certCompany,
      // CAC only applies to a graded coin.
      hasCacSticker: cacStickerFor(grade, hasCacSticker),
      country, metalHint, ambiguities
    };
  }

  /**
   * The coin's metal when the security name states it: a canonical Metal value
   * ('Gold', 'Silver', ...) or '' (the usual case).
   */
  private detectMetalHint(securityName: string): string {
    // Remove "CAC Gold" / "Gold CAC" (slashed and hyphenated too) first: a sticker
    // tier, not the metal.
    const scrubbed = securityName
      .replace(/\bCAC\b\s*[-/]?\s*\bGold\b/gi, 'CAC')
      .replace(/\bGold\b\s*[-/]?\s*\bCAC\b/gi, 'CAC');

    // "G$1", "G$2.50", "G$3": collector shorthand for the gold issues.
    if (/\bG\$/i.test(securityName)) return 'Gold';

    if (/\bgold\b/i.test(scrubbed)) return 'Gold';
    if (/\bsilver\b/i.test(scrubbed)) return 'Silver';
    if (/\bplatinum\b/i.test(scrubbed)) return 'Platinum';
    if (/\bpalladium\b/i.test(scrubbed)) return 'Palladium';
    return '';
  }

  private inferCoinType(
    securityName: string,
    denomination: string,
    year: string,
    metalHint = ''
  ): string {
    const lowerName = securityName.toLowerCase();
    const yearNum = parseInt(year, 10) || 0;

    // Set-type coins ("Proof Set", "Maundy Set"): the coin type is the set name.
    if (/\bproof\s+set\b/i.test(lowerName)) return 'Proof Set';
    if (/\bmint\s+set\b/i.test(lowerName)) return 'Mint Set';
    if (/\bmaundy\s+set\b/i.test(lowerName)) return 'Maundy Set';

    // Explicit issue names win over year-based rules, so commemoratives aren't
    // mislabelled by their date.
    if (/\boregon\s*(?:trail)?\b/i.test(lowerName)) return 'Oregon Trail';
    if (/\bcap\s*&\s*rays?\b|cap\s+and\s+rays\b/i.test(lowerName)) return 'Cap & Rays';
    if (/\bcommemorative\b/i.test(lowerName) && /\btrail\b/i.test(lowerName)) return 'Oregon Trail';
    if (/\b8\s*reales\b|\b8\s*real\b/i.test(lowerName)) return 'Cap & Rays';

    // Explicit coin type names
    if (/\bmorgan\b/i.test(lowerName)) return 'Morgan';
    if (/\bpeace\b/i.test(lowerName)) return 'Peace';
    if (/\bwalking\s*liberty\b/i.test(lowerName)) return 'Walking Liberty';
    if (/\bstanding\s*liberty\b/i.test(lowerName)) return 'Standing Liberty';
    if (/\bseated\s*liberty\b|\bliberty\s*seated\b/i.test(lowerName)) return 'Liberty Seated';
    if (/\bbarber\b/i.test(lowerName)) return 'Barber';
    if (/\bmercury\b/i.test(lowerName)) return 'Mercury';
    if (/\broosevelt\b/i.test(lowerName)) return 'Roosevelt';
    if (/\bwashington\b/i.test(lowerName)) return 'Washington';
    if (/\bfranklin\b/i.test(lowerName)) return 'Franklin';
    if (/\bkennedy\b/i.test(lowerName)) return 'Kennedy';
    if (/\blincoln\b/i.test(lowerName)) return 'Lincoln';
    if (/\bindian\s*head\b/i.test(lowerName)) return 'Indian Head';
    if (/\bflying\s*eagle\b/i.test(lowerName)) return 'Flying Eagle';
    if (/\bbuffalo\b/i.test(lowerName)) return 'Buffalo';
    if (/\bjefferson\b/i.test(lowerName)) return 'Jefferson';
    if (/\bshield\b/i.test(lowerName)) return 'Shield';
    if (/\bliberty\s*head\b/i.test(lowerName)) return 'Liberty Head';
    if (/\bdraped\s*bust\b/i.test(lowerName)) return 'Draped Bust';
    if (/\bflowing\s*hair\b/i.test(lowerName)) return 'Flowing Hair';
    if (/\bcapped\s*bust\b/i.test(lowerName)) return 'Capped Bust';
    if (/\bbraided\s*hair\b/i.test(lowerName)) return 'Braided Hair';
    if (/\bclassic\s*head\b/i.test(lowerName)) return 'Classic Head';
    if (/\bcoronet\b/i.test(lowerName)) return 'Coronet';
    if (/\btrade\b/i.test(lowerName) && denomination === '$1') return 'Trade';
    if (/\bst\.\s*gaudens\b|\bsaint[\s-]?gaudens\b/i.test(lowerName)) return 'Saint-Gaudens';

    if (!yearNum) return '';

    /*
     * The Gold Dollar. A "$1" from 1849-1889 is either a silver dollar or the Gold
     * Dollar; the year table below knows only the silver series.
     *   Type 1  1849-1854  Liberty Head
     *   Type 2  1854-1856  Indian Princess, Small Head
     *   Type 3  1856-1889  Indian Princess, Large Head
     * 1854-1856 is left blank because types overlap there. Year and Denomination
     * still satisfy the 2-of-3 rule, so the coin imports and the user picks the type.
     * This is a decline, not a guess, so it isn't reported as an `AmbiguousReading`.
     */
    if (denomination === '$1' && metalHint === 'Gold') {
      if (yearNum >= 1849 && yearNum <= 1853) return 'Liberty Head';
      if (yearNum >= 1857 && yearNum <= 1889) return 'Indian Princess';
      return '';
    }

    // Year-based inference by denomination.
    return inferCoinTypeByYear(denomination, yearNum);
  }
}
