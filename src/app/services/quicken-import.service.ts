/**
 * Parses Quicken Interchange Format (QIF) investment-transaction exports
 * and normalizes them into coin import records.
 *
 * Quicken's QIF investment fields are single-letter codes with specific,
 * well-defined meanings (see the Quicken Interchange Format reference).
 * The two easiest to get wrong -- because their letters read like other
 * things -- are:
 *   - `N` is the transaction ACTION (Buy, Sell, ShrsIn, ReinvDiv, ...),
 *     not a free-text name.
 *   - `Y` is the SECURITY name, which for a coin-tracking Quicken account
 *     is where the coin's description actually lives.
 *
 * Full investment field-line reference used here:
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
// "Was this coin struck as a proof?" is a question this project already has
// exactly one answer to, and it lives in proof-strike.ts. The three-cent rule
// below needs that answer, so it ASKS rather than writing a second copy of
// the detection -- a second copy is how the import side and the image matcher
// would come to disagree about the same slab label. Nothing in proof-strike.ts
// changes; this is a read-only consumer of settled rules.
import { detectStrike } from './image-matching/proof-strike';
// `composePmFields` asks pm-reference.ts "what is this coin made of?" -- for
// BOTH precious and base metal coins -- and hands the answer back already
// named the way a coin record names it: Metal Content / Composition / PM % /
// PM weight.
//
// It lives in its own file (pm-fill.ts) rather than inline here because the
// Settings > Maintenance "backfill precious-metal data" action needs the
// identical mapping to fill in the blanks on coins that pre-date this import.
// Two hand-written copies of the same mapping is how the two paths would come
// to disagree about the same physical coin, so there is exactly one.
import { composePmFields } from './pm-fill';
// Country and foreign-denomination vocabulary -- see coin-countries.ts for
// why "1969 Peru 100 Soles" needs its own reader.
import { detectCountry, detectForeignDenomination } from './coin-countries';
// The 2-of-3 "is this really a coin?" rule is shared with the manual
// add-a-coin flow — see the re-export block further down for why.
import { checkMainCoinDetails } from './coin-completeness';

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
    // The Classic Head years were a gap in this table, so an 1835 or 1836
    // gold piece came out with a blank Coin Type. They are the coins struck
    // under the Act of 1834, which cut the weight and set the fineness to
    // 0.8992 -- see the matching year bands in pm-reference.ts.
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
    // Same Classic Head gap as the quarter eagle above: this collection
    // contains an "1835 $5 - NGC/CAC XF45" that had no Coin Type at all.
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

/* ===========================================================================
 * A BARE "3¢": SILVER OR NICKEL?
 * ---------------------------------------------------------------------------
 * There were two three-cent pieces, and a name that just says "3¢" (or
 * "3c", or "three cent") does not say which one is in the holder:
 *
 *     THREE CENT SILVER   "3CS", the trime   struck 1851 - 1873
 *     THREE CENT NICKEL   "3CN"              struck 1865 - 1889
 *
 * They OVERLAP from 1865 to 1873. Nine years in which the date tells you
 * nothing at all.
 *
 * WHAT THIS CODE USED TO DO, AND WHY IT WAS WRONG
 *   denomination = yearNum && yearNum >= 1865 ? '3CN' : '3CS';
 *
 *   One line, no comment, no flag. Every single year of the overlap came out
 *   "3CN" and the guess was then indistinguishable from a fact: the preview
 *   printed it like any other denomination, the database stored it like any
 *   other denomination, and the image matcher -- which has a whole mechanism
 *   (`describeUndecidedGeneric` in match-decider.ts) for REFUSING to choose
 *   between 3CS and 3CN -- never got the chance to use it, because by the
 *   time it saw the record the choice had already been made for it.
 *
 *   reference-tables.ts names this exact mistake, in a block titled "THE YEAR
 *   CANNOT RESCUE YOU", and uses 3CS vs 3CN as its first example.
 *
 * WHAT IT DOES NOW -- THREE BANDS, TWO OF THEM CERTAIN
 *
 *   year <= 1864   ->  3CS, CERTAIN.  The nickel did not exist yet.
 *   year >= 1874   ->  3CN, CERTAIN.  The silver had ended.
 *   1865 - 1873    ->  a GUESS, and flagged as one.
 *
 *   Note what changed at the edges: a bare "3¢" dated 1874-1889 used to be
 *   read as 3CN by the same line that guessed the overlap, and it still is --
 *   but it is no longer tarred with the guess, because for those years there
 *   is nothing to guess.
 *
 * HOW THE GUESS IS MADE, IN THE OWNER'S OWN WORDS
 *   Asked whether the importer should stop guessing altogether, he said:
 *
 *     "For 3-cent coins, it's save to assume to pick the more common
 *      variation. For instance, after 1862, the 3CS coins are very scarce
 *      with the exception of Proofs. It's okay to make an assumption and note
 *      to the user that there was ambiguity in a choice so they can either
 *      fix the choice right away or later or just cancel the match."
 *
 *   Read the middle sentence carefully, because the exception clause is the
 *   whole rule. Three-cent SILVER business strikes after 1862 are tiny --
 *   hundreds of coins a year, versus three-cent NICKEL business strikes in
 *   the millions. But three-cent silver PROOFS kept being struck in normal
 *   proof quantities right through 1873. So:
 *
 *     the name carries a proof designation  ->  3CS
 *     anything else                         ->  3CN
 *
 *   HIS OWN COLLECTION IS THE EVIDENCE. Every single three-cent SILVER coin
 *   he holds inside the overlap window is a proof -- 1865 PF64, 1866 PF65,
 *   1867 PF65 Cameo, 1868 PR65, 1870 PF64, 1871 PF64 -- while his overlap-era
 *   three-cent NICKELS are a mix of circulated grades and proofs. That is
 *   exactly the shape his sentence predicts.
 *
 *   The question "is this a proof?" is NOT re-implemented here. It is asked
 *   of `detectStrike` (proof-strike.ts), which already reads both the grade
 *   ("PF64", "PR65") and the words ("Proof", but never "prooflike") and is
 *   the same reader the image matcher uses.
 *
 * A NAME WITH NO YEAR AT ALL
 *   Treated as the widest possible ambiguity -- the whole 1851-1889 span is
 *   open -- so it gets the same tie-break and the same flag. (This does
 *   change the old behaviour, which quietly answered 3CS for an undated bare
 *   "3¢". It is flagged now either way, and a sweep of all seven of his QIF
 *   files found ZERO bare three-cent names of any kind: every one of his 117
 *   three-cent securities spells out "3CS" or "3CN", so no real row moves.)
 *
 * WHETHER THE GUESS IS RIGHT IS NOT THIS FUNCTION'S PROBLEM ANY MORE.
 *   It returns the guess AND the reasoning, the preview shows both, and the
 *   user re-points or drops the row. That is the arrangement the owner asked
 *   for, in place of the two alternatives he rejected: refusing to guess, and
 *   dropping the record.
 * ======================================================================== */

/** First year the three-cent SILVER was struck. Nothing before it. */
const THREE_CENT_SILVER_FIRST_YEAR = 1851;
/** Last year the three-cent SILVER was struck. Nothing after it. */
const THREE_CENT_SILVER_LAST_YEAR = 1873;
/** First year the three-cent NICKEL was struck -- and the overlap's start. */
const THREE_CENT_NICKEL_FIRST_YEAR = 1865;
/** Last year the three-cent NICKEL was struck. */
const THREE_CENT_NICKEL_LAST_YEAR = 1889;

/**
 * Decide what a bare three-cent reading means, and say whether it was a guess.
 *
 * @param yearNum       The parsed year, or 0 when the name carried none.
 * @param securityName  The untouched Quicken security name -- handed to
 *                      `detectStrike` as the descriptive text.
 * @param grade         The grade already parsed out of that name ("PF64").
 * @returns the denomination, plus an `AmbiguousReading` when -- and only
 *          when -- the answer was not forced by the date.
 */
function resolveBareThreeCent(
  yearNum: number,
  securityName: string,
  grade: string
): { denomination: string; ambiguity?: AmbiguousReading } {
  // CERTAIN: before the nickel existed, a three-cent piece is a trime.
  if (yearNum && yearNum < THREE_CENT_NICKEL_FIRST_YEAR) {
    return { denomination: '3CS' };
  }

  // CERTAIN: after the silver ended, a three-cent piece is a nickel.
  if (yearNum && yearNum > THREE_CENT_SILVER_LAST_YEAR) {
    return { denomination: '3CN' };
  }

  /* THE OVERLAP (or an undated name). The date is worthless here, so fall
   * back to the owner's scarcity rule, with proofs as its stated exception.
   * `detectStrike` returns 'business' for silence -- he writes the proof
   * designation whenever it applies -- which is precisely the behaviour this
   * rule wants, so no extra handling is needed for an unmarked name. */
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
      // Both members, always, in series order -- so the preview can offer the
      // one we did NOT pick without having to work out what it is.
      alternatives: ['3CS', '3CN'],
      why: `${situation}; ${reasoning}. Check this one.`
    }
  };
}

/* ---------------------------------------------------------------------------
 * CERTIFICATION (GRADING) COMPANIES
 *
 * These are the third-party grading services whose names actually appear in
 * this collection's Quicken security names, e.g.
 *
 *     "1927 $20 - PCGS MS64"
 *     "1875 20¢ - ANACS VG8"
 *     "1886 $1 - ICG MS64DMPL"
 *     "1909 S-VDB 1¢ - PCGS/CAC AU58"
 *
 * WHY THIS IS A LIST OF REGEXES AND NOT A LIST OF STRINGS
 * A plain `securityName.includes('NGC')` would be wrong in two ways:
 *   1. It would fire on "NGC" buried inside a longer word (the bug the
 *      requirements call out explicitly).
 *   2. It would be case-sensitive, and Quicken names are hand-typed.
 *
 * So every entry is anchored with `\b` on both sides -- a WHOLE-TOKEN match --
 * and compiled case-insensitively. `\b` is a word boundary, meaning the
 * position between a word character ([A-Za-z0-9_]) and anything else. That is
 * exactly what we want here, because the separators these names actually use
 * -- space, hyphen, slash, backslash, parenthesis -- are all NON-word
 * characters. All of these therefore match:
 *
 *     "- PCGS MS64"        (space on both sides)
 *     "-PCGS PF65"         (hyphen before)
 *     "PCGS/CAC AU58"      (slash after)
 *     "(CLEANED/PCGS)"     (slash before, paren after)
 *
 * ...while "XPCGSY" does not.
 *
 * ORDER MATTERS ONLY FOR CACG. It is listed FIRST so that a name reading
 * "CACG MS65" is credited to CACG rather than to some other company that also
 * happened to appear. (CACG cannot be confused with the CAC *sticker* -- see
 * the CAC_STICKER_PATTERN comment below for that distinction.)
 * ------------------------------------------------------------------------- */
const CERT_COMPANY_PATTERNS: readonly { token: string; pattern: RegExp }[] = [
  // CAC's own grading service (a slab), NOT the CAC sticker (a sticker on
  // someone else's slab). Deliberately first -- see note above.
  { token: 'CACG',  pattern: /\bCACG\b/i },
  { token: 'PCGS',  pattern: /\bPCGS\b/i },
  { token: 'NGC',   pattern: /\bNGC\b/i },
  { token: 'ANACS', pattern: /\bANACS\b/i },
  { token: 'ICG',   pattern: /\bICG\b/i },
  { token: 'SEGS',  pattern: /\bSEGS\b/i },
  { token: 'NNC',   pattern: /\bNNC\b/i },
];

/* ---------------------------------------------------------------------------
 * THE CAC STICKER  (`hasCacSticker`)
 *
 * CAC (Certified Acceptance Corporation) puts a small green sticker on a slab
 * it agrees is solid for the grade. It is a SEPARATE thing from the grading
 * company, and it is the single most common "extra" in this collection's
 * Quicken names -- overwhelmingly written with a slash after the grader:
 *
 *     "1909 S-VDB 1¢ - PCGS/CAC AU58"
 *     "1835 $5 - NGC/CAC XF45"
 *     "1870 $1 - PCGS/CAC PF62+"
 *
 * ...but also seen in the wild as `CAC`, `CAC'd`, `CACd`, `w/CAC`, `+CAC`,
 * `(CAC)`, and `CAC Gold` / `Gold CAC`.
 *
 * *** CAC  vs  CACG -- the one trap in this whole file ***
 * `CACG` is CAC's GRADING SERVICE. A CACG-slabbed coin is not a
 * CAC-stickered coin, so seeing "CACG" must set `certCompany = 'CACG'` and
 * must leave `hasCacSticker` FALSE.
 *
 * The whole-token `\b` rule already gives us that for free, and it is worth
 * spelling out why:
 *   - In "CACG", the character after "CAC" is "G". Both "C" and "G" are word
 *     characters, so there is NO word boundary between them, so `\bCAC\b`
 *     fails to match. Correct.
 *   - In "PCGS/CAC", the character after "CAC" is the end of the string (or a
 *     space) and the one before it is "/", so both boundaries hold. Matches.
 *
 * The only form `\bCAC\b` does NOT cover on its own is `CACd` ("CAC'd" with
 * the apostrophe dropped), because "d" is a word character -- the same reason
 * CACG is excluded. So the optional `(?:'?d)?` group is spliced in to accept
 * `CAC`, `CAC'd` and `CACd` while still rejecting `CACG`.
 * ------------------------------------------------------------------------- */
const CAC_STICKER_PATTERN = /\bCAC(?:'?d)?\b/i;

/** Action codes that represent acquiring a position -- i.e. a coin entering the collection. */
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

/** Action codes that represent disposing of a position -- a coin that has left the collection. */
const DISPOSITION_ACTIONS = new Set(['sell', 'sellx', 'shrsout', 'shtsell', 'rtrncap']);

/** Action codes for cash-only transfers — no security involved, skip silently. */
const CASH_TRANSFER_ACTIONS = new Set(['xin', 'xout']);

/* ---------------------------------------------------------------------------
 * THE 2-OF-3 MAIN-DETAIL RULE USED TO BE WRITTEN OUT IN THIS FILE.
 *
 * It now lives in `coin-completeness.ts`, because the manual "Add coin"
 * button needs the very same rule to decide when a half-typed new row has
 * become worth saving to the database. Two copies of a validation rule is
 * exactly how they drift apart, so there is now precisely one copy and both
 * callers import it.
 *
 * These re-exports keep this service's public surface (and its tests)
 * unchanged: `import { checkMainCoinDetails } from './quicken-import.service'`
 * still works and still resolves to the one shared implementation.
 * ------------------------------------------------------------------------- */
export {
  MINIMUM_MAIN_DETAILS,
  isCoinDetailPresent,
  checkMainCoinDetails
} from './coin-completeness';
export type { CoinDetailCheck } from './coin-completeness';

/**
 * A coin that parsed successfully but did not carry enough detail to import.
 * These are surfaced to the user as "exceptions" -- never silently dropped --
 * so they can see exactly which QIF rows were skipped and why.
 */
export interface QuickenRejectedRecord {
  /** The raw `Y` (security name) line the coin came from. */
  securityName: string;
  /** What we *were* able to parse, so the user can judge / override. */
  record: QuickenImportRecord;
  present: string[];
  missing: string[];
  reason: string;
}

export interface QuickenParseResult {
  importedRecords: QuickenImportRecord[];
  skippedRecords: QuickenImportRecord[]; // Coins with net quantity <= 0 (sold or transferred out)
  /** Coins held (net qty > 0) but failing the 2-of-3 main-detail rule. */
  rejectedRecords: QuickenRejectedRecord[];
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
   * Parses raw QIF text into normalized coin import records.
   *
   * Net-quantity filtering: Tracks both acquisitions and dispositions
   * to calculate the net quantity (current holdings) per security.
   * Only coins with net qty > 0 are included in importedRecords;
   * coins with net qty <= 0 (fully sold or transferred out) are
   * returned in skippedRecords for reference.
   *
   * @param qifText Raw contents of a `.qif` export.
   * @param selectedAccounts When provided, only transactions under a
   *   matching `!Account` block are imported; all discovered account
   *   names are still returned via `accounts` so the caller can build an
   *   account picker.
   * @param denominationChoices The user's answers to readings this parser
   *   flagged as GUESSES, keyed on the raw Quicken security name. See
   *   `AmbiguousReading` in coin.model.ts.
   *
   *   WHY THE ANSWER COMES IN HERE RATHER THAN BEING PAINTED ON AFTERWARDS.
   *   A denomination is not a loose label; the coin type and all five alloy /
   *   weight fields are computed FROM it. Flipping "3CN" to "3CS" in the
   *   caller would leave a trime carrying the copper-nickel composition and
   *   the nickel's 1.94 g weight. Handing the choice to the parser instead
   *   means the single existing derivation path produces every dependent
   *   field, so they cannot disagree.
   *
   *   A choice is honoured ONLY for a security whose reading was actually
   *   flagged, and only when the value is one the parser itself offered. A
   *   stale entry -- for a security that has since been renamed in Quicken,
   *   or a value nobody offered -- is ignored rather than trusted. This is
   *   not a back door for editing arbitrary fields during import.
   */
  parse(
    qifText: string,
    selectedAccounts?: string | string[],
    denominationChoices?: Readonly<Record<string, string>>
  ): QuickenParseResult {
    const warnings: string[] = [];
    const accounts = new Set<string>();
    let currentAccount: string | null = null;

    // Net-quantity tracking map: security name -> { qty, latestRecord, latestDate }
    // We track all transactions (acquisitions and dispositions) to determine
    // which coins are still held (net qty > 0).
    const netQuantityMap = new Map<
      string,
      { qty: number; latestRecord: QuickenImportRecord | null; latestDate: string }
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

      // Optimize: Skip !Type:Prices blocks immediately without parsing fields.
      // Price history is not relevant for coin inventory import.
      if (firstLine.startsWith('!Type:Prices')) {
        continue;
      }

      // A bare header line (e.g. `!Type:Invst`) with nothing else in the
      // block carries no transaction data.
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

      // Skip cash-only transfers (no security involved)
      if (CASH_TRANSFER_ACTIONS.has(actionKey)) {
        continue;
      }

      // Parse attributes from security name. The user's answer to any
      // previously flagged guess for THIS security goes in with it, so the
      // coin type and the alloy below are derived from the corrected
      // denomination rather than from the parser's original assumption.
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

      // NOTE: there is deliberately NO "is this coin detailed enough?" test
      // here. That rule lives in exactly one place -- the final assembly loop
      // below -- so that no code path can reach `importedRecords` without
      // passing it. (The previous version tested `!year && !denomination`
      // here, which only rejected coins missing BOTH fields, and then bolted
      // on a regex for bare "1934"-style names. See the assembly loop.)

      const purchaseDate = fields.date ? this.normalizeDate(fields.date) : '';

      /* -------------------------------------------------------------------
       * WHAT IS IT MADE OF?
       *
       * The alloy follows from the country, the denomination and the YEAR --
       * a 1964 quarter is 90% silver and a 1965 quarter has none, and the
       * only difference between them is the date. pm-reference.ts owns all of
       * those rules; `composePmFields` (pm-fill.ts) is the single shared
       * adapter that renames its answer into coin-record fields, and the
       * Settings backfill calls the very same function.
       *
       * `attrs.metalHint` is passed through because a handful of face values
       * existed in two metals at once (the 1849-1889 "$1" was struck as both
       * a silver dollar and a gold dollar). When the security name says
       * "Gold" or "G$1" out loud, that settles it; when nothing at all does,
       * the fields stay blank on purpose. An empty field is something the user
       * can see and fix -- a wrong purity silently produces a wrong melt
       * value.
       * ----------------------------------------------------------------- */
      const alloy = composePmFields(
        attrs.denomination,
        attrs.year,
        attrs.country,
        attrs.metalHint,
        /* -----------------------------------------------------------------
         * THE COARSE FALLBACK'S EXTRA EVIDENCE.
         *
         * The reference table is keyed on denomination + year, so an issue it
         * carries no row for -- foreign gold, an unusual face value, a type
         * not yet tabulated -- used to contribute NOTHING and the coin
         * imported with all four alloy fields blank. The COIN TYPE is exactly
         * what the owner said makes the metal obvious ("Gold Eagle",
         * "Saint-Gaudens", "Double Eagle"), so it is handed over too.
         *
         * It only ever gets a turn when `lookupCoinAlloy` has already
         * declined, and all it can add is Metal Content. There is no
         * composition on a brand-new import, so that half is always empty
         * here; the Settings backfill is where it earns its keep.
         * --------------------------------------------------------------- */
        { coinType: attrs.coinType }
      );

      // Build the import record
      const record: QuickenImportRecord = {
        id: crypto.randomUUID(),
        denomination: attrs.denomination,
        year: attrs.year,
        coinType: attrs.coinType,
        grade: attrs.grade,
        // Grading service + CAC sticker, both read out of the same security
        // name as everything else above. `hasCacSticker` is always a real
        // boolean so it can be bound straight to the BIT NOT NULL column.
        certCompany: attrs.certCompany,
        hasCacSticker: attrs.hasCacSticker,
        mintMark: attrs.mintMark,
        variety: attrs.variety,
        account: currentAccount ?? 'Unassigned',
        purchaseDate,
        purchasePrice,
        currentValue: purchasePrice,
        // Read from the security name when it names a country, falling back
        // to this collection's long-standing default. See parseAttributes.
        country: attrs.country,
        notes: fields.memo ?? '',
        source: 'quicken',
        // All five alloy / weight fields come from the single lookup above,
        // so they can never disagree with each other. Three outcomes: the
        // reference table knew the coin and all five are filled; only the
        // coarse metal inference could answer and `metalContent` alone is
        // filled; or neither would commit and all five stay undefined.
        metalContent: alloy?.metalContent,
        composition: alloy?.composition,
        pmWeightGrams: alloy?.pmWeightGrams,
        pmPercent: alloy?.pmPercent,
        // The coin's GROSS weight in grams -- the whole coin, not just the
        // precious metal in it. It comes from the same reference row as the
        // other four, so a coin can never end up claiming 30.09 g of gold
        // inside a planchet that weighs less than that.
        weight: alloy?.weight,
        /* The raw Quicken name, carried only so the import preview has a key
         * that survives a re-parse (`id` does not -- it is a fresh UUID every
         * time). Never copied onto CoinRecord, never stored. */
        securityName: fields.security,
        /* WHAT THE PARSE GUESSED AT.
         *
         * Undefined -- not [] -- on the overwhelming majority of coins, so a
         * reader can test `record.ambiguities?.length` and get an honest
         * answer. When it IS set, the row still imports: an ambiguous reading
         * is a flag, not a rejection. The owner was explicit that a record
         * must not be dropped for being ambiguous; it must be surfaced so he
         * "can either fix the choice right away or later or just cancel the
         * match". See `AmbiguousReading` in coin.model.ts. */
        ambiguities: attrs.ambiguities.length > 0 ? attrs.ambiguities : undefined
      };

      // Track net quantity: acquisitions add +1, dispositions add -1
      const existing = netQuantityMap.get(fields.security) ?? {
        qty: 0,
        latestRecord: null,
        latestDate: ''
      };

      if (DISPOSITION_ACTIONS.has(actionKey)) {
        // Disposition: decrement quantity
        existing.qty -= 1;
        netQuantityMap.set(fields.security, existing);
      } else if (ACQUISITION_ACTIONS.has(actionKey)) {
        // Acquisition: increment quantity and update latest record if newer
        existing.qty += 1;
        if (purchaseDate >= existing.latestDate) {
          existing.latestRecord = record;
          existing.latestDate = purchaseDate;
        }
        netQuantityMap.set(fields.security, existing);
      } else {
        // Unrecognized action: treat as acquisition but warn
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

    // ---------------------------------------------------------------------
    // THE SINGLE CHOKE POINT.
    //
    // Every record that ends up in `importedRecords` passes through this one
    // loop, so this is the only place the import rules need to be enforced.
    // Two gates, in order:
    //   1. Net quantity: coins fully sold/transferred out (qty <= 0) are not
    //      held any more, so they go to `skippedRecords`.
    //   2. Main-detail rule: a held coin still needs at least 2 of
    //      Year / Coin Type / Denomination, or it goes to `rejectedRecords`
    //      (an exception the user can see -- and optionally override in the
    //      import modal) rather than being silently dropped.
    // ---------------------------------------------------------------------
    const importedRecords: QuickenImportRecord[] = [];
    const skippedRecords: QuickenImportRecord[] = [];
    const rejectedRecords: QuickenRejectedRecord[] = [];

    for (const [securityName, data] of netQuantityMap.entries()) {
      const record = data.latestRecord;
      if (!record) {
        // Only dispositions were seen for this security -- there was never an
        // acquisition to build a record from, so there is nothing to report.
        continue;
      }

      if (data.qty <= 0) {
        // Gate 1: coin has been fully sold or transferred out.
        skippedRecords.push(record);
        continue;
      }

      // Gate 2: the 2-of-3 main-detail rule.
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
      warnings,
      accounts: [...accounts]
    };
  }

  /** Reads the account name out of an `!Account` block's `N` line. */
  private extractAccountName(lines: string[]): string {
    const nameLine = lines.find((line) => line.startsWith('N'));
    return nameLine?.slice(1).trim() || 'Unknown Account';
  }

  /**
   * Extracts the known investment field codes from a transaction block.
   * Returns `null` when the block contains none of them, meaning it is
   * not an investment transaction this parser understands.
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
   * Determines the transaction's dollar amount, preferring an explicit
   * `T`/`U` amount field and falling back to price x quantity + commission
   * when Quicken only recorded the trade legs.
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

  /** Parses a QIF numeric value, tolerating thousands separators. */
  private parseAmount(value: string): number {
    const cleaned = value.replace(/,/g, '').trim();
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Normalizes a QIF date (`M/D/YYYY`, `M/D'YY`, `MM-DD-YYYY`, etc.) into
   * an ISO `YYYY-MM-DD` string. Falls back to the original text when the
   * shape is unrecognized rather than guessing.
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
      // Already ISO-ish (`YYYY-MM-DD`). Some exporters -- and our own test
      // fixtures -- use this. Reading it as M/D/Y produced nonsense like
      // "2001-2024-02", which then compared wrongly against the date filters.
      [year, month, day] = parts;
    } else {
      // Quicken's native order: M/D/Y.
      [month, day, year] = parts;
    }

    if (year.length <= 2) {
      // Quicken writes 2-digit years; 00-50 -> 2000s, 51-99 -> 1900s.
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
      // Unrecognized shape -- return the original text rather than guessing.
      return value;
    }

    return `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
  }

  /**
   * Parses structured attributes from a Quicken security name.
   *
   * Typical Quicken security name format for coins:
   *   "1875S 20c-XF"
   *   "1921 Morgan Dollar MS63"
   *   "1916D Mercury Dime VF/XF"
   *
   * Extraction rules:
   * - Year: Leading 4-digit number (e.g., "1875", "1921")
   * - Mintmark: Single letter immediately after 4-digit year with no space (e.g., "1875S" -> "S")
   * - Grade: After "-" or space, patterns like VF, EF, XF, AU, MS, PR, PF, Unc, AG, G, VG, F,
   *          plus modifiers like AU58, MS63, CH+AU, VF/EF, VF/XF
   * - CertCompany: Whole-token match against the known grading services
   *          (PCGS, NGC, ANACS, ICG, SEGS, CACG, NNC)
   * - HasCacSticker: Whole-token "CAC" (and its spelling variants), which is a
   *          DIFFERENT thing from the CACG grading service
   * - Denomination: Pattern match to symbolic format (3CS→3CS, 20c→20¢, half→50¢, etc.)
   * - Variety: Only if explicit keywords (Type I, Type II, DDO, DDR)
   * - CoinType: Left blank (determined later by UI or enrichment)
   *
   * NOTE: every rule below reads the ORIGINAL `securityName`. Nothing is
   * stripped or rewritten as we go, so the rules cannot interfere with each
   * other. That is what keeps "PCGS MS63" yielding BOTH certCompany "PCGS"
   * and grade "MS63" -- detecting the company never consumes the grade.
   *
   * @param securityName The security name (Y field) from Quicken
   * @param chosenDenomination The user's answer to a reading this parser
   *   previously flagged as a guess. Applied after the denomination ladder
   *   and BEFORE the coin type is inferred, so everything derived from the
   *   denomination follows the corrected value. Ignored unless this name
   *   really did produce a denomination ambiguity offering that value.
   * @returns Parsed attributes
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
    /**
     * Readings this parse was NOT sure about. Empty on nearly every name --
     * see `AmbiguousReading` in coin.model.ts for what goes in here and why
     * it is a general list rather than a per-coin special case.
     */
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

    // Extract year, including an overdate suffix when present (e.g. 1862/1).
    const yearMatch = securityName.match(/^(\d{4}(?:\/\d{1,2})?)/);
    if (yearMatch) {
      year = yearMatch[1];
    }

    // Extract mintmark immediately after the year, with or without a hyphen.
    // Common mintmarks: S, D, O, CC, C, W, P, etc.
    const mintMarkMatch = securityName.match(/^(?:\d{4}(?:\/\d{1,2})?)[-\s]?([A-Z]{1,2})(?:\b|[-\s])/i);
    if (mintMarkMatch) {
      const discovered = mintMarkMatch[1].toUpperCase();
      if (['P', 'D', 'S', 'O', 'C', 'CC', 'W', 'MM'].includes(discovered)) {
        mintMark = discovered;
      }
    }

    // Extract grade (after "-" or space).
    //
    // Two passes, because a single expression could not cover both cases
    // without either missing designations or mis-parsing plain grades.
    //
    // PASS 1 handles a numeric grade carrying a DESIGNATION suffix:
    //   PF65RB, PF64Cameo, PF65 Cameo, PF69DCAM, MS64DMPL, MS70-FS, MS64+
    //
    //   These used to come out EMPTY. The old expression ended in `\b`
    //   immediately after the digits, and in "PF65RB" there is no word
    //   boundary between "5" and "R" (both are word characters), so the whole
    //   match failed and the grade was silently lost. Proof and copper coins
    //   are overwhelmingly graded with designations, so this discarded the
    //   grade for a large part of the collection.
    //
    //   The trailing `(?![A-Z0-9])` replaces `\b`: it asserts the grade is not
    //   followed by another letter or digit. Unlike `\b` it also succeeds
    //   after a "+" (as in MS64+), which `\b` cannot do because "+" is not a
    //   word character.
    //
    // PASS 2 is the original expression, used only when pass 1 finds nothing.
    // It keeps plain grades (XF, AU53, VF/EF, CH+AU) working exactly as
    // before, so nothing that used to parse can regress.
    const GRADE_CORE =
      String.raw`(?:CH\+)?(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|AG|VG|F|G)` +
      String.raw`(?:\/(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|AG|VG|F|G))?`;

    // Standard numismatic designations. Longer alternatives come first so
    // that, e.g., "CAMEO" is preferred over the shorter "CAM" and "DMPL"
    // over "PL".
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
      // Collapse any internal separator so "PF65 Cameo" and "PF65Cameo"
      // both normalise to the same stored value.
      grade = gradeMatch[1].toUpperCase().replace(/[-\s]+/g, '');
    }

    // -----------------------------------------------------------------------
    // Extract the certification (grading) company.
    //
    // First whole-token hit wins. We store the BARE token in its canonical
    // upper-case spelling ("pcgs" in the QIF becomes "PCGS") and nothing else:
    // the CertCompany column is NVARCHAR(100), but the coin editor's input is
    // capped at 10 characters, so storing something like
    // "PCGS (with CAC sticker)" would produce a value the user cannot edit.
    //
    // This runs AFTER the grade above and reads the untouched security name,
    // so a company sitting immediately before a grade -- "PCGS MS63",
    // "ANACS VG8", "NGC PF65RB", "ANACS PF69 DCAM", "NGC PF64Cameo" -- leaves
    // the already-extracted grade completely alone.
    // -----------------------------------------------------------------------
    for (const candidate of CERT_COMPANY_PATTERNS) {
      if (candidate.pattern.test(securityName)) {
        certCompany = candidate.token;
        break;
      }
    }

    // -----------------------------------------------------------------------
    // Extract the CAC sticker flag.
    //
    // Remember: CAC (a green sticker on someone else's slab) is NOT CACG
    // (CAC's own grading service). The whole-token pattern is what enforces
    // that -- "CACG" cannot match `\bCAC\b` because there is no word boundary
    // between the "C" and the "G". See CAC_STICKER_PATTERN for the full
    // explanation.
    //
    // Always a boolean, never undefined: the database column is
    // BIT NOT NULL DEFAULT 0 and the UI renders a checkbox from it.
    // -----------------------------------------------------------------------
    const hasCacSticker = CAC_STICKER_PATTERN.test(securityName);

    // Extract variety (explicit keywords only)
    if (/Type\s*I\b/i.test(securityName)) {
      variety = 'Type I';
    } else if (/Type\s*II\b/i.test(securityName)) {
      variety = 'Type II';
    } else if (/\bDDO\b/i.test(securityName)) {
      variety = 'DDO';
    } else if (/\bDDR\b/i.test(securityName)) {
      variety = 'DDR';
    }

    /* -----------------------------------------------------------------------
     * COUNTRY
     *
     * This parser used to hard-code "United States" for every row. That was
     * right for 43 of the 44 coins in this collection and wrong for the one
     * that would not import:
     *
     *     "1969 Peru 100 Soles - NGC MS64"
     *
     * `detectCountry` reads a country named in the text, and failing that
     * accepts a currency unit that can only belong to one country ("Soles"
     * proves Peru on its own). When it finds nothing we keep the old default,
     * because this is an American collector's export.
     * --------------------------------------------------------------------- */
    const country = detectCountry(securityName) || 'United States';

    /* -----------------------------------------------------------------------
     * METAL HINT
     *
     * A few face values existed in two metals at the same time -- above all
     * the "$1", struck as a 26.73 g SILVER dollar and a 1.67 g GOLD dollar in
     * the same years (1849-1889). pm-reference.ts refuses to guess between
     * them, so when the security name settles the question we pass the answer
     * along. Three forms appear in this collection:
     *
     *     "1849-O $1 Gold - ANACS XF45"       the word
     *     "1855 G$1 - PCGS/CAC AU50"          the "G$" shorthand
     *     "1873 Open 3 G$2.50 - ANACS AU53"   ditto
     *
     * *** THE TRAP ***
     * "CAC Gold" and "Gold CAC" do NOT describe the coin's metal. They
     * describe CAC's gold STICKER -- the tier above its usual green one --
     * and they sit on silver coins all the time:
     *
     *     "1875 20¢ - PCGS XF40 CAC Gold"     a SILVER twenty-cent piece
     *
     * Those pairings are scrubbed before the metal words are read, or that
     * coin would be imported as gold.
     * --------------------------------------------------------------------- */
    const metalHint = this.detectMetalHint(securityName);

    // Extract denomination (convert to symbolic format)
    const lowerName = securityName.toLowerCase();
    const yearNum = parseInt(year, 10) || 0;

    /* -----------------------------------------------------------------------
     * FOREIGN DENOMINATION -- "100 Soles", "20 Francs", "50 Pesos"
     *
     * Read BEFORE the US table below, but only used ahead of it when the coin
     * is not American. The US table understands "$20" and "50¢"; it has no
     * idea what a Sol is, which is exactly why the Peru record came out with
     * a blank denomination and failed the 2-of-3 rule.
     *
     * For a US coin the foreign reader almost never fires, and if it somehow
     * did we would rather trust the US table -- hence the country test.
     * --------------------------------------------------------------------- */
    const foreign = detectForeignDenomination(securityName);

    /* -----------------------------------------------------------------------
     * ISRAELI SHEQALIM, WRITTEN AS A BARE "S"
     *
     * "1982 Israel Qumran 5S - ANACS PF69DCAM" is five sheqalim, but the unit
     * is abbreviated to a single letter with no space -- so the general
     * number-and-unit reader in coin-countries.ts cannot see it. That reader
     * deliberately requires a separator between the count and the unit,
     * because a bare letter glued to a number is exactly the shape of a grade
     * suffix or a mintmark, and loosening it there would cost far more than
     * this one coin is worth.
     *
     * So the rule is narrow ON PURPOSE: the name must ALSO say Israel. The
     * owner confirmed the reading himself, and without the country guard "5S"
     * would start claiming sheqalim out of every other account he owns.
     * --------------------------------------------------------------------- */
    const sheqalim = /\bisrael/i.test(securityName)
      ? /\b(\d{1,4})\s?S\b/.exec(securityName)
      : null;

    // A non-US coin whose name carries a "<number> <currency unit>" reading
    // is settled here -- "1969 Peru 100 Soles" is a 100 Soles, full stop.
    if (foreign && country !== 'United States') {
      denomination = foreign.denomination;
    // See the `sheqalim` read above for why this one is guarded on Israel.
    } else if (sheqalim) {
      denomination = `${sheqalim[1]} Sheqalim`;
    // Explicit silver/nickel three-cent variants (words or abbreviations)
    } else if (/three[\s-]?cent[\s-]?silver|3cs\b/i.test(lowerName)) {
      denomination = '3CS';
    } else if (/three[\s-]?cent[\s-]?nickel|3cn\b/i.test(lowerName)) {
      denomination = '3CN';
    /* A bare 3¢ / "three cent" / "3c" with no silver-or-nickel qualifier.
     * The date settles it outside 1865-1873 and is worthless inside it, so
     * this delegates to `resolveBareThreeCent` above -- which returns the
     * guess AND, when it really was a guess, the flag that says so. Read the
     * block comment on that function; it quotes the owner's rule in full. */
    } else if (/3¢/.test(securityName) || /three[\s-]?cent/i.test(lowerName) || /\b3c\b/.test(lowerName)) {
      const threeCent = resolveBareThreeCent(yearNum, securityName, grade);
      denomination = threeCent.denomination;
      if (threeCent.ambiguity) {
        ambiguities.push(threeCent.ambiguity);
      }
    /* -----------------------------------------------------------------------
     * SYMBOL-BASED DENOMINATIONS (½¢, ½10¢, 1¢, 2¢, 5¢, 10¢, 20¢, 25¢, 50¢)
     *
     * THE ORDER OF THESE BRANCHES IS THE WHOLE RULE: LONGEST SPELLING FIRST.
     *
     * This is an if/else ladder over SUBSTRING tests, so a shorter cent
     * spelling that happens to sit inside a longer one wins whenever it is
     * tried first -- and two of his real securities were landing on exactly
     * that, which is why the order below is now explicit and commented:
     *
     *   "1868 25¢ - NGC/CAC PF64 Cameo"  CONTAINS "5¢", so with /5¢/ tried
     *                                    first his QUARTER was imported as
     *                                    a five-cent piece
     *   "1860 ½10¢ - PCGS/CAC PF64"      the half-dime spelling was in no
     *                                    branch at all, so it fell through
     *                                    to /10¢/ and his HALF DIME was
     *                                    imported as a DIME
     *
     * Both were silent, and both produced silent damage downstream. His
     * `Early Proofs` account holds nine ½10¢ half dimes and two 25¢
     * quarters alongside genuine 10¢ dimes and a genuine 5¢ -- so the
     * mis-reads did not merely lose information, they collided with real
     * coins. The image matcher then did exactly what it is supposed to do
     * with the data it was given: it attached the photographs of
     * "1868 ½10¢" to the record that claimed to be an 1868 five-cent piece,
     * which is really his 1868 quarter. One wrong denomination, two coins
     * cross-filed.
     *
     * RULE FOR ANYONE ADDING A ROW: put it above every spelling it contains
     * a copy of. "½10¢" contains "10¢"; "25¢" contains "5¢". When in doubt,
     * longest first.
     * --------------------------------------------------------------------- */
    } else if (/½¢|1\/2¢/.test(securityName) || /half[\s-]?cent/i.test(lowerName)) {
      denomination = '½¢';
    /* THE HALF DIME, written as half of a dime. The owner: "Half Dime can be
     * ½10¢ or 5¢". It is literal -- a half dime IS half of ten cents -- and
     * it must be tried before /10¢/ below, which would otherwise read the
     * trailing "10¢" and report twice the face value. (The matcher's own
     * reader, denomination-units.ts, has had this rule and this ordering
     * warning since the half-dime work; this is the import side catching
     * up with it.) */
    } else if (/½\s*10¢|1\/2\s*10¢/.test(securityName) || /half[\s-]?dime/i.test(lowerName)) {
      denomination = '5¢';
    /* ATB -- "America the Beautiful". Every coin in the series is a QUARTER,
     * including the five-ounce silver pieces, whose bullion weight says
     * nothing about the face value stamped on them. The abbreviation is how
     * the owner writes them ("2011 5oz. ATB Vicksburg"), and without this
     * branch those three came in with no denomination at all. Matched
     * case-SENSITIVELY, as an initialism. */
    } else if (/\bATB\b/.test(securityName)) {
      denomination = '25¢';
    /* 25¢ ABOVE 5¢, because "25¢" contains "5¢". */
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
    /* -----------------------------------------------------------------------
     * THE EAGLES, AND WHY THEY NEED THEIR OWN ORDERING
     *
     * "Eagle" is not one denomination, it is a family, and the metal and the
     * YEAR decide which member you are holding. The owner's own words:
     *
     *   "Silver Eagle only refers to $1, where a (Gold) Eagle is $10 and a
     *    (Gold) Double Eagle is $20, a (Gold) Half Eagle is $5, and a (Gold)
     *    Quarter Eagle is $2.50."
     *
     *   "It's true that a modern Gold Eagle actually refers to the $50 bullion
     *    coin, but that should be easy to determine because of the modern year
     *    (they only were minted starting in 1986)."
     *
     * Before this block existed, the bare eagle test below swallowed the
     * silver ones, and three of his real securities -- "1987 Proof Silver
     * Eagle", "2006 Proof Silver Eagle" and "2008 Proof Silver Eagle" -- were
     * imported as TEN DOLLAR GOLD PIECES. Silver therefore has to be asked
     * about FIRST and the modern gold year-rule second, leaving the classic
     * $10 Eagle as the fall-through it always was.
     * --------------------------------------------------------------------- */
    /* A multi-coin SET is the one eagle that is deliberately given NOTHING.
     *
     * "1987 2-coin Proof American Gold Eagle Set (1.5 troy oz.)" is a $50 AND
     * a $25 in one holding, so no single denomination is correct. This has to
     * be its own branch that assigns '' rather than merely declining to set
     * $50: an if/else ladder that only SKIPS a branch carries on down, and
     * the generic eagle test below would then label the set a $10 gold piece
     * -- the same class of silent damage as the half dimes that came in as
     * dimes. Blank sends it to the exceptions list, where the owner says what
     * he means. */
    } else if (/gold\s*eagle/i.test(securityName) && /\bsets?\b/i.test(securityName)) {
      denomination = '';
    // Silver Eagle (and the collector's abbreviation ASE) is the $1 bullion
    // coin, whatever else the name says. 'ASE' is matched case-SENSITIVELY:
    // it is an initialism, and a lowercase "ase" is far likelier to be the
    // tail of an ordinary word than a denomination.
    } else if (/silver\s*eagle/i.test(securityName) || /\bASE\b/.test(securityName)) {
      denomination = '$1';
    } else if (/double\s*eagle|[\$£]20\b/i.test(securityName)) {
      denomination = '$20';
    /* The modern one-ounce Gold Eagle carries a $50 face value and has been
     * struck only since 1986, so the year settles it with no ambiguity. Sets
     * never reach here -- they were stopped above. */
    } else if (/gold\s*eagle/i.test(securityName) && yearNum >= 1986) {
      denomination = '$50';
    } else if (/\beagle\b|[\$£]10\b/i.test(securityName)) {
      denomination = '$10';
    /* $50 and $25 ABOVE $5 and $2.50, per this ladder's longest-first rule.
     * These two are the modern bullion face values -- the $50 one-ounce gold
     * (Eagle and Buffalo) and the $25 half-ounce -- and until the matching
     * denominations were seeded by migration 009 the importer had nowhere to
     * put them, so names like "1986S Au $50-PF" and "2025 $50 Gold Buffalo"
     * came in with no denomination at all. */
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
    /* SBA -- the Susan B. Anthony dollar. Another initialism the owner uses
     * on its own ("1999 SBA - PF"), with no other denomination word in the
     * name to fall back on. Case-SENSITIVE for the same reason as ASE. */
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
      // Last chance: the US table recognised nothing, but the name does carry
      // a number bound to a currency unit. This is the path a coin takes when
      // its denomination is foreign but its name never says which country --
      // "1915 20 Francs" gets a denomination even though France, Belgium and
      // Switzerland all struck one and we refuse to guess which.
      denomination = foreign.denomination;
    } else {
      denomination = '';
    }

    /* -----------------------------------------------------------------------
     * THE USER OVERRULES THE GUESS.
     *
     * This is the "fix the choice right away" half of what the owner asked
     * for. It sits HERE -- after the ladder, before anything derived from the
     * denomination -- for one reason: the coin type below and the alloy /
     * weight fields back in `parse` are both computed from `denomination`, so
     * correcting it any later would leave them describing the coin the parser
     * guessed rather than the coin he says it is.
     *
     * TWO GUARDS, AND THEY MATTER. The value is accepted only when
     *   (a) this name actually produced a denomination ambiguity -- a
     *       certain reading is not up for negotiation, and
     *   (b) the value is one of the alternatives the parser itself listed.
     * Without them a stale entry from an earlier QIF, or a hand-edited one,
     * could set any denomination on any row. Correcting a guess is not the
     * same thing as free-text editing the import, and the coin editor is
     * where the latter belongs.
     * --------------------------------------------------------------------- */
    if (chosenDenomination) {
      const flagged = ambiguities.find(
        a => a.field === 'denomination' && a.alternatives.includes(chosenDenomination)
      );
      if (flagged) {
        denomination = chosenDenomination;
        // Keep the flag itself truthful: it still records that this reading
        // was ambiguous and what the candidates were, but `chosen` now says
        // what is actually on the record.
        flagged.chosen = chosenDenomination;
      }
    }

    // Infer coinType from explicit name keywords or denomination + year.
    // `metalHint` matters here too: a "$1" that says Gold is a Gold Dollar,
    // a completely different series from the silver dollar of the same date.
    coinType = this.inferCoinType(securityName, denomination, year, metalHint);

    // NOTE: certCompany and hasCacSticker are deliberately NOT part of the
    // 2-of-3 "main details" completeness rule (Year / Coin Type /
    // Denomination) enforced in `coin-completeness.ts`. A slab label tells you
    // who graded the coin, not what the coin is, so a row carrying only
    // "PCGS MS64" is still an exception, exactly as before this was added.
    return {
      year, mintMark, grade, denomination, variety, coinType, certCompany, hasCacSticker,
      country, metalHint, ambiguities
    };
  }

  /**
   * Reads the coin's METAL out of the security name, when the name says it.
   *
   * Returns one of the canonical Metal values ('Gold', 'Silver', ...) or ''
   * when the name is silent -- which is the normal case. See the long comment
   * at the call site in `parseAttributes` for why the CAC scrub matters.
   */
  private detectMetalHint(securityName: string): string {
    // Remove "CAC Gold" / "Gold CAC" (and the slashed and hyphenated
    // spellings) BEFORE looking for a metal word. That phrase is CAC's gold
    // sticker tier, not the coin's metal, and it appears on silver coins.
    const scrubbed = securityName
      .replace(/\bCAC\b\s*[-/]?\s*\bGold\b/gi, 'CAC')
      .replace(/\bGold\b\s*[-/]?\s*\bCAC\b/gi, 'CAC');

    // "G$1", "G$2.50", "G$3" -- the collector shorthand for GOLD dollar,
    // gold quarter eagle and three-dollar gold. Four of this collection's
    // coins are written this way.
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

    // Check for set-type coins (e.g., "Proof Set", "Maundy Set") — coinType IS the set name
    if (/\bproof\s+set\b/i.test(lowerName)) return 'Proof Set';
    if (/\bmint\s+set\b/i.test(lowerName)) return 'Mint Set';
    if (/\bmaundy\s+set\b/i.test(lowerName)) return 'Maundy Set';

    // Explicit issue names should win over year-based denomination heuristics.
    // This keeps commemoratives and special issues from being mislabeled by their date.
    if (/\boregon\s*(?:trail)?\b/i.test(lowerName)) return 'Oregon Trail';
    if (/\bcap\s*&\s*rays?\b|cap\s+and\s+rays\b/i.test(lowerName)) return 'Cap & Rays';
    if (/\bcommemorative\b/i.test(lowerName) && /\btrail\b/i.test(lowerName)) return 'Oregon Trail';
    if (/\b8\s*reales\b|\b8\s*real\b/i.test(lowerName)) return 'Cap & Rays';

    // Explicit coin type names in the security name
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

    /* -----------------------------------------------------------------------
     * THE GOLD DOLLAR.
     *
     * "$1" between 1849 and 1889 is two completely different coins: the
     * silver dollar (Liberty Seated, then Morgan) and the Gold Dollar, a
     * 13 mm sliver of 90% gold. The year-based table below only knows the
     * silver series, so before this check "1849-O $1 Gold" imported as a
     * "Liberty Seated" -- with 24 g of silver attached to it.
     *
     * The three Gold Dollar types:
     *   Type 1  1849-1854  Liberty Head
     *   Type 2  1854-1856  Indian Princess, Small Head
     *   Type 3  1856-1889  Indian Princess, Large Head
     *
     * 1854 through 1856 is left BLANK on purpose: those three dates overlap
     * two (in 1854, three) types and a Quicken name does not say which.
     * Blank is fine -- Year and Denomination already satisfy the 2-of-3 rule,
     * so the coin still imports and the user picks the type.
     *
     * SHOULD THIS USE THE AMBIGUOUS-READING CHANNEL? CONSIDERED; NO.
     *   `AmbiguousReading` (coin.model.ts) exists so that a GUESS can be
     *   shown to the user as a guess. This branch does not guess -- it
     *   declines, and the decline is already visible: the preview prints an
     *   em dash in the Coin Type column, which is the agreed way this project
     *   says "nothing here, fill it in". The problem the channel was built to
     *   solve is a guess WEARING THE CLOTHES OF A FACT, and a blank cell is
     *   the opposite of that.
     *
     *   The two cases are also not the same shape. A three-cent reading has
     *   exactly two candidates and picking the wrong one silently mis-files
     *   photographs; a Gold Dollar in 1854 has two or three candidates and a
     *   blank coin type costs nothing downstream. Flagging a blank would add
     *   a "check this" banner to rows where there is nothing to check beyond
     *   what the dash already says.
     *
     *   The channel stays available to it: `AmbiguousReading.field` is a
     *   union including 'coinType' precisely so this branch (or any other)
     *   can start using it the day declining stops being good enough.
     * --------------------------------------------------------------------- */
    if (denomination === '$1' && metalHint === 'Gold') {
      if (yearNum >= 1849 && yearNum <= 1853) return 'Liberty Head';
      if (yearNum >= 1857 && yearNum <= 1889) return 'Indian Princess';
      return '';
    }

    // Year-based inference by denomination
    return inferCoinTypeByYear(denomination, yearNum);
  }
}
