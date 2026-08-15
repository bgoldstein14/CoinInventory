import { Injectable } from '@angular/core';
import { QuickenImportRecord } from '../types/coin.model';

@Injectable({ providedIn: 'root' })
export class QuickenImportService {
  parse(
    qifText: string,
    selectedAccounts?: string | string[]
  ): { importedRecords: QuickenImportRecord[]; warnings: string[]; accounts: string[] } {
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
      const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const firstLine = lines[0]?.trim() ?? '';

      if (firstLine.startsWith('!Account')) {
        const accountName =
          lines
            .find((line) => line.startsWith('N'))
            ?.slice(1)
            .trim() || 'Unknown Account';

        currentAccount = accountName;
        accounts.add(accountName);
        continue;
      }

      const isInvestmentBlock =
        firstLine.startsWith('!Type') ||
        lines.some((line) => /^[DNTMY]/.test(line));

      if (!isInvestmentBlock) {
        continue;
      }

      const record: Partial<QuickenImportRecord> = {
        source: 'quicken'
      };

      for (const line of lines) {
        const prefix = line[0];
        const value = line.slice(1).trim();

        switch (prefix) {
          case 'D':
            record.purchaseDate = value;
            break;
          case 'N':
            record.name = value || 'Imported Coin';
            break;
          case 'T':
            record.purchasePrice = Number.parseFloat(value) || 0;
            break;
          case 'M':
            record.notes = value;
            break;
          case 'Y':
            record.type = value || 'Unknown';
            break;
          default:
            break;
        }
      }

      if (selected.length > 0 && currentAccount && !selected.includes(currentAccount)) {
        continue;
      }

      if (selected.length > 0 && !currentAccount) {
        continue;
      }

      if (!record.name) {
        warnings.push('Encountered a Quicken block without a name.');
        continue;
      }

      const denomination = this.inferDenomination(record.name, record.notes ?? '');
      const normalized: QuickenImportRecord = {
        id: crypto.randomUUID(),
        name: record.name,
        denomination,
        account: currentAccount ?? 'Unassigned',
        purchaseDate: record.purchaseDate,
        purchasePrice: record.purchasePrice ?? 0,
        currentValue: record.purchasePrice ?? 0,
        country: 'United States',
        type: record.type ?? 'Unknown',
        notes: record.notes ?? '',
        source: 'quicken'
      };

      records.push(normalized);
    }

    return { importedRecords: records, warnings, accounts: [...accounts] };
  }

  private inferDenomination(name: string, notes: string): string {
    const text = `${name} ${notes}`.toLowerCase();
    if (/1\/2\s*dime|half dime/.test(text)) return 'Half Dime';
    if (/dime/.test(text)) return 'Dime';
    if (/quarter/.test(text)) return 'Quarter';
    if (/half dollar|50c/.test(text)) return 'Half Dollar';
    if (/dollar/.test(text)) return 'Dollar';
    return 'Unknown';
  }
}
