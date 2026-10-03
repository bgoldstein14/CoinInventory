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
import { QuickenImportRecord } from '../types/coin.model';
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
   */
  parse(qifText: string, selectedAccounts?: string | string[]): QuickenParseResult {
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

      // Parse attributes from security name
      const attrs = this.parseAttributes(fields.security);
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
        weight: alloy?.weight
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
   * @returns Parsed attributes
   */
  private parseAttributes(securityName: string): {
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
  } {
    let year = '';
    let mintMark = '';
    let grade = '';
    let denomination = '';
    let variety = '';
    let coinType = '';
    let certCompany = '';

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

    // A non-US coin whose name carries a "<number> <currency unit>" reading
    // is settled here -- "1969 Peru 100 Soles" is a 100 Soles, full stop.
    if (foreign && country !== 'United States') {
      denomination = foreign.denomination;
    // Explicit silver/nickel three-cent variants (words or abbreviations)
    } else if (/three[\s-]?cent[\s-]?silver|3cs\b/i.test(lowerName)) {
      denomination = '3CS';
    } else if (/three[\s-]?cent[\s-]?nickel|3cn\b/i.test(lowerName)) {
      denomination = '3CN';
    // 3¢ symbol or "three cent" without qualifier — disambiguate by year
    } else if (/3¢/.test(securityName) || /three[\s-]?cent/i.test(lowerName) || /\b3c\b/.test(lowerName)) {
      denomination = yearNum && yearNum >= 1865 ? '3CN' : '3CS';
    // Symbol-based denominations (½¢, 1¢, 2¢, 5¢, 10¢, 20¢, 25¢, 50¢)
    } else if (/½¢|1\/2¢/.test(securityName) || /half[\s-]?cent/i.test(lowerName)) {
      denomination = '½¢';
    } else if (/5¢/.test(securityName) || /half[\s-]?dime/i.test(lowerName) || /\bnickel\b/i.test(lowerName)) {
      denomination = '5¢';
    } else if (/10¢/.test(securityName) || /\bdime\b/i.test(lowerName)) {
      denomination = '10¢';
    } else if (/25¢/.test(securityName) || /\bquarter\b/i.test(lowerName) || /\b25c\b/.test(lowerName)) {
      denomination = '25¢';
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
    } else if (/double\s*eagle|[\$£]20\b/i.test(securityName)) {
      denomination = '$20';
    } else if (/\beagle\b|[\$£]10\b/i.test(securityName)) {
      denomination = '$10';
    } else if (/[\$£]5\b/.test(securityName)) {
      denomination = '$5';
    } else if (/[\$£]3\b/.test(securityName)) {
      denomination = '$3';
    } else if (/[\$£]2\.50\b/.test(securityName)) {
      denomination = '$2.50';
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
      country, metalHint
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
