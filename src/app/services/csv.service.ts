import { Injectable } from '@angular/core';
import { CoinRecord } from '../types/coin.model';

export const CSV_MAPPABLE_FIELDS: { key: string; label: string }[] = [
  { key: '', label: '(skip)' },
  { key: 'name', label: 'Name' },
  { key: 'denomination', label: 'Denomination' },
  { key: 'year', label: 'Year' },
  { key: 'type', label: 'Type' },
  { key: 'category', label: 'Category' },
  { key: 'country', label: 'Country' },
  { key: 'grade', label: 'Grade' },
  { key: 'certCompany', label: 'Cert Company' },
  { key: 'certNumber', label: 'Cert Number' },
  { key: 'variety', label: 'Variety' },
  { key: 'mintMark', label: 'Mint Mark' },
  { key: 'composition', label: 'Composition' },
  { key: 'purchaseDate', label: 'Purchase Date' },
  { key: 'purchasePrice', label: 'Purchase Price' },
  { key: 'currentValue', label: 'Current Value' },
  { key: 'notes', label: 'Notes' },
  { key: 'dealer', label: 'Dealer' },
  { key: 'coinSet', label: 'Set' },
  { key: 'metalContent', label: 'Metal Content' },
  { key: 'weight', label: 'Weight (oz)' },
  { key: 'soldPrice', label: 'Sold Price' },
  { key: 'soldDate', label: 'Sold Date' }
];

@Injectable({ providedIn: 'root' })
export class CsvService {

  parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let current: string[] = [];
    let inQuotes = false;
    let field = '';

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          current.push(field);
          field = '';
        } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
          current.push(field);
          field = '';
          rows.push(current);
          current = [];
          if (ch === '\r') i++;
        } else {
          field += ch;
        }
      }
    }

    if (field || current.length > 0) {
      current.push(field);
      rows.push(current);
    }

    return rows;
  }

  autoMapHeaders(headers: string[]): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const header of headers) {
      const lower = header.toLowerCase().trim();
      const match = CSV_MAPPABLE_FIELDS.find(f =>
        f.key && (f.key.toLowerCase() === lower || f.label.toLowerCase() === lower)
      );
      if (match) mapping[header] = match.key;
    }
    return mapping;
  }

  mapRowToCoin(row: string[], headers: string[], mapping: Record<string, string>): CoinRecord {
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      name: 'Imported Coin',
      denomination: '',
      year: null,
      type: '',
      category: '',
      country: 'United States',
      grade: '',
      certCompany: '',
      certNumber: '',
      variety: '',
      mintMark: '',
      composition: '',
      purchaseDate: '',
      purchasePrice: 0,
      currentValue: 0,
      notes: '',
      imagePaths: [],
      tags: [],
      source: 'csv',
      hasCacSticker: false
    };

    for (let i = 0; i < headers.length; i++) {
      const field = mapping[headers[i]];
      const value = (row[i] ?? '').trim();
      if (!field || !value) continue;

      if (field === 'year') {
        (coin as unknown as Record<string, unknown>)[field] = Number(value) || null;
      } else if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
        (coin as unknown as Record<string, unknown>)[field] = Number(value.replace(/[$,]/g, '')) || 0;
      } else {
        (coin as unknown as Record<string, unknown>)[field] = value;
      }
    }

    return coin;
  }

  exportCsv(coins: CoinRecord[]): void {
    const columns: (keyof CoinRecord)[] = [
      'name', 'denomination', 'year', 'type', 'category', 'country', 'grade',
      'certCompany', 'certNumber', 'variety', 'mintMark', 'composition',
      'purchaseDate', 'purchasePrice', 'currentValue', 'notes', 'dealer',
      'coinSet', 'metalContent', 'weight', 'soldPrice', 'soldDate', 'source'
    ];
    const headerLabels = [
      'Name', 'Denomination', 'Year', 'Type', 'Category', 'Country', 'Grade',
      'Cert Company', 'Cert Number', 'Variety', 'Mint Mark', 'Composition',
      'Purchase Date', 'Purchase Price', 'Current Value', 'Notes', 'Dealer',
      'Set', 'Metal Content', 'Weight (oz)', 'Sold Price', 'Sold Date', 'Source'
    ];

    const lines = [headerLabels.join(',')];
    for (const coin of coins) {
      const row = columns.map(col => this.escapeCsvField(coin[col] ?? ''));
      lines.push(row.join(','));
    }

    this.downloadBlob(lines.join('\n'), 'coin-inventory.csv', 'text/csv');
  }

  exportInsuranceCsv(coins: CoinRecord[]): void {
    const lines = ['Name,Grade,Cert Company,Cert Number,Current Value,Purchase Price,Purchase Date,Notes'];
    for (const coin of coins) {
      lines.push([
        this.escapeCsvField(coin.name),
        this.escapeCsvField(coin.grade),
        this.escapeCsvField(coin.certCompany),
        this.escapeCsvField(coin.certNumber),
        coin.currentValue.toFixed(2),
        coin.purchasePrice.toFixed(2),
        this.escapeCsvField(coin.purchaseDate),
        this.escapeCsvField(coin.notes)
      ].join(','));
    }

    this.downloadBlob(lines.join('\n'), 'coin-insurance-schedule.csv', 'text/csv');
  }

  private escapeCsvField(value: unknown): string {
    const str = value == null ? '' : String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  private downloadBlob(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
