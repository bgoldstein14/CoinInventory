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
import { lookupPmData } from './pm-reference';
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
    { min: 1840, max: 1907, coinType: 'Coronet' },
    { min: 1908, max: 1929, coinType: 'Indian Head' },
  ],
  '$3': [
    { min: 1854, max: 1889, coinType: 'Indian Princess' },
  ],
  '$5': [
    { min: 1795, max: 1807, coinType: 'Draped Bust' },
    { min: 1807, max: 1834, coinType: 'Capped Bust' },
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

      // Look up precious metal data based on denomination and year
      const pmData = lookupPmData(attrs.denomination, attrs.year, 'United States');

      // Build the import record
      const record: QuickenImportRecord = {
        id: crypto.randomUUID(),
        denomination: attrs.denomination,
        year: attrs.year,
        coinType: attrs.coinType,
        grade: attrs.grade,
        mintMark: attrs.mintMark,
        variety: attrs.variety,
        account: currentAccount ?? 'Unassigned',
        purchaseDate,
        purchasePrice,
        currentValue: purchasePrice,
        country: 'United States',
        notes: fields.memo ?? '',
        source: 'quicken',
        pmWeightGrams: pmData?.pmWeightGrams,
        pmPercent: pmData?.pmPercent
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
   * - Denomination: Pattern match to symbolic format (3CS→3CS, 20c→20¢, half→50¢, etc.)
   * - Variety: Only if explicit keywords (Type I, Type II, DDO, DDR)
   * - CoinType: Left blank (determined later by UI or enrichment)
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
  } {
    let year = '';
    let mintMark = '';
    let grade = '';
    let denomination = '';
    let variety = '';
    let coinType = '';

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

    // Extract grade (after "-" or space, common patterns)
    // Match patterns: VF, EF, XF, AU, MS, PR, PF, Unc, AG, G, VG, F
    // with optional modifiers: AU58, MS63, CH+AU, VF/EF, VF/XF, etc.
    const gradeMatch = securityName.match(
      /[-\s]((?:CH\+)?(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|Unc|AG|VG|F|G)(?:\/(?:BU|UNC|VF|EF|XF|AU|MS|PR|PF|Unc|AG|VG|F|G))?(?:\d{1,2})?)\b/i
    );
    if (gradeMatch) {
      grade = gradeMatch[1].toUpperCase();
    }

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

    // Extract denomination (convert to symbolic format)
    const lowerName = securityName.toLowerCase();
    const yearNum = parseInt(year, 10) || 0;

    // Explicit silver/nickel three-cent variants (words or abbreviations)
    if (/three[\s-]?cent[\s-]?silver|3cs\b/i.test(lowerName)) {
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
    } else {
      denomination = '';
    }

    // Infer coinType from explicit name keywords or denomination + year
    coinType = this.inferCoinType(securityName, denomination, year);

    return { year, mintMark, grade, denomination, variety, coinType };
  }

  private inferCoinType(securityName: string, denomination: string, year: string): string {
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

    // Year-based inference by denomination
    return inferCoinTypeByYear(denomination, yearNum);
  }
}
