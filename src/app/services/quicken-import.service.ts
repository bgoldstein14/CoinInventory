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
   * @param qifText Raw contents of a `.qif` export.
   * @param selectedAccounts When provided, only transactions under a
   *   matching `!Account` block are imported; all discovered account
   *   names are still returned via `accounts` so the caller can build an
   *   account picker.
   */
  parse(qifText: string, selectedAccounts?: string | string[]): QuickenParseResult {
    const records: QuickenImportRecord[] = [];
    const warnings: string[] = [];
    const accounts = new Set<string>();
    let currentAccount: string | null = null;

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

      if (CASH_TRANSFER_ACTIONS.has(actionKey)) {
        continue;
      }

      if (DISPOSITION_ACTIONS.has(actionKey)) {
        // A sale/transfer-out means this coin is no longer held -- importing
        // it as current inventory would misrepresent the collection.
        warnings.push(
          `Skipped "${fields.security}" -- recorded as a ${fields.action} (disposition), not a current holding.`
        );
        continue;
      }

      if (fields.action && !ACQUISITION_ACTIONS.has(actionKey)) {
        warnings.push(
          `Imported "${fields.security}" with an unrecognized action code (${fields.action}); please verify the cost basis.`
        );
      }

      const purchasePrice = this.resolveAmount(fields);
      const denomination = this.inferDenomination(fields.security, fields.memo ?? '');

      records.push({
        id: crypto.randomUUID(),
        name: fields.security,
        denomination,
        account: currentAccount ?? 'Unassigned',
        purchaseDate: fields.date ? this.normalizeDate(fields.date) : undefined,
        purchasePrice,
        currentValue: purchasePrice,
        country: 'United States',
        type: '',
        notes: fields.memo ?? '',
        source: 'quicken'
      });
    }

    return { importedRecords: records, warnings, accounts: [...accounts] };
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
}
