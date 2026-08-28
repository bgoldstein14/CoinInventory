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

export interface QuickenParseResult {
  importedRecords: QuickenImportRecord[];
  skippedRecords: QuickenImportRecord[]; // Coins with net quantity <= 0 (sold or transferred out)
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
        warnings.push('Skipped a Quicken transaction with no security name (Y field).');
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

    // Filter to only coins with net qty > 0 (currently held)
    const importedRecords: QuickenImportRecord[] = [];
    const skippedRecords: QuickenImportRecord[] = [];

    for (const [securityName, data] of netQuantityMap.entries()) {
      if (data.qty > 0 && data.latestRecord) {
        importedRecords.push(data.latestRecord);
      } else if (data.qty <= 0 && data.latestRecord) {
        // Coin has been fully sold or transferred out
        skippedRecords.push(data.latestRecord);
        warnings.push(
          `Skipped "${securityName}" -- net quantity is ${data.qty} (fully disposed).`
        );
      }
    }

    return { importedRecords, skippedRecords, warnings, accounts: [...accounts] };
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

    const [month, day, rawYear] = parts;
    let year = rawYear;
    if (year.length <= 2) {
      const yearNumber = Number.parseInt(year, 10);
      year = String(yearNumber <= 50 ? 2000 + yearNumber : 1900 + yearNumber);
    }

    const paddedMonth = month.padStart(2, '0');
    const paddedDay = day.padStart(2, '0');
    if (year.length !== 4 || Number.isNaN(Number(paddedMonth)) || Number.isNaN(Number(paddedDay))) {
      return value;
    }

    return `${year}-${paddedMonth}-${paddedDay}`;
  }

  /** Best-effort denomination guess from the security name and memo text. */
  private inferDenomination(name: string, notes: string): string {
    const text = `${name} ${notes}`.toLowerCase();
    if (/half[\s-]?dime/.test(text)) return 'Half Dime';
    if (/\bcent\b|\bpenny\b/.test(text)) return 'Cent';
    if (/\bnickel\b/.test(text)) return 'Nickel';
    if (/\bdime\b/.test(text)) return 'Dime';
    if (/\bquarter\b/.test(text)) return 'Quarter';
    if (/half[\s-]?dollar|50c/.test(text)) return 'Half Dollar';
    if (/double eagle|\$?20\s*dollar/.test(text)) return '20 Dollar';
    if (/\beagle\b|\$?10\s*dollar/.test(text)) return '10 Dollar';
    if (/\bdollar\b/.test(text)) return 'Dollar';
    return 'Unknown';
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
   * - Denomination: Pattern match to symbolic format (3CS→3¢ Silver, 20c→20¢, half→50¢, etc.)
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
    const coinType = ''; // Left blank for now

    // Extract year (leading 4-digit number)
    const yearMatch = securityName.match(/^(\d{4})/);
    if (yearMatch) {
      year = yearMatch[1];
    }

    // Extract mintmark (single letter immediately after year, no space)
    // Common mintmarks: S, D, O, CC, C, W, P
    const mintMarkMatch = securityName.match(/^\d{4}([SDOCWP]{1,2})\b/i);
    if (mintMarkMatch) {
      mintMark = mintMarkMatch[1].toUpperCase();
    }

    // Extract grade (after "-" or space, common patterns)
    // Match patterns: VF, EF, XF, AU, MS, PR, PF, Unc, AG, G, VG, F
    // with optional modifiers: AU58, MS63, CH+AU, VF/EF, VF/XF, etc.
    const gradeMatch = securityName.match(
      /[-\s]((?:CH\+)?(?:VF|EF|XF|AU|MS|PR|PF|Unc|AG|VG|F|G)(?:\/(?:VF|EF|XF|AU|MS|PR|PF|Unc|AG|VG|F|G))?(?:\d{1,2})?)\b/i
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

    // Special patterns first
    if (/3cs\b/.test(lowerName)) {
      denomination = '3¢ Silver';
    } else if (/3cn\b/.test(lowerName)) {
      denomination = '3¢ Nickel';
    } else if (/\b2c\b/.test(lowerName)) {
      denomination = '2¢';
    } else if (/\b20c\b/.test(lowerName)) {
      denomination = '20¢';
    } else if (/\b8\s*real/i.test(lowerName)) {
      denomination = '8 Reales';
    } else if (/half[\s-]?dime/i.test(lowerName)) {
      denomination = '5¢'; // Half dime is 5 cents
    } else if (/half[\s-]?dollar|\bhalf\b/i.test(lowerName)) {
      denomination = '50¢';
    } else if (/\bcent\b|\bpenny\b/i.test(lowerName)) {
      denomination = '1¢';
    } else if (/\bnickel\b/i.test(lowerName)) {
      denomination = '5¢';
    } else if (/\bdime\b/i.test(lowerName)) {
      denomination = '10¢';
    } else if (/\bquarter\b/i.test(lowerName)) {
      denomination = '25¢';
    } else if (/double\s*eagle|\$20\b/i.test(lowerName)) {
      denomination = '$20';
    } else if (/\beagle\b|\$10\b/i.test(lowerName)) {
      denomination = '$10';
    } else if (/\$5\b/i.test(lowerName)) {
      denomination = '$5';
    } else if (/\$3\b/i.test(lowerName)) {
      denomination = '$3';
    } else if (/\$2\.50\b/i.test(lowerName)) {
      denomination = '$2.50';
    } else if (/\$1\b|\bdollar\b/i.test(lowerName)) {
      denomination = '$1';
    } else {
      denomination = ''; // Unknown denomination
    }

    return { year, mintMark, grade, denomination, variety, coinType };
  }
}
