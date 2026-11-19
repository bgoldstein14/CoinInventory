import { Injectable } from '@angular/core';
import { CoinRecord } from '../types/coin.model';
import { parseNumericCell } from './csv/numeric-cell';
import { mapHeadersToFields } from './csv/header-synonyms';
import { ColumnValueEvidence } from './csv/date-column-shape';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';
import { BOM, stripBom } from './csv/byte-order-mark';
import { normalizeCollectionStatus } from '../types/collection-status';
import { CatalogOption, formatCatalogRefs, normalizeCatalogRefs, parseCatalogRefs } from '../types/catalog-reference';
// The shared denomination resolver (see denominations/denomination-index.ts).
import {
  resolveDenominationId,
  type IndexableDenomination
} from './denominations/denomination-index';

/** Allowed `CoinRecord.source` values; an imported Source cell is validated against these. */
const KNOWN_COIN_SOURCES: readonly string[] = ['manual', 'quicken', 'import', 'csv'];

/** Re-exported from csv/mappable-fields.ts for existing importers. */
export { CSV_MAPPABLE_FIELDS };

@Injectable({ providedIn: 'root' })
export class CsvService {

  parseCsv(rawText: string): string[][] {
    // Strip a leading BOM, or the first header reads `﻿Coin Type` and stays
    // unmapped (see csv/byte-order-mark.ts).
    const text = stripBom(rawText);

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

  /**
   * Guesses which coin field each column holds (rules in csv/header-synonyms.ts),
   * for both the CSV and `.xlsx` paths. Unplaced headers are absent from the
   * result and show as "(skip)".
   *
   * @param columnValues optional sampled cells per column, keyed by header text,
   *   used to settle an ambiguous `Date` heading. Use `textColumnSamples` for
   *   plain rows or `WorkbookSheet.valueSamples` for a workbook (which also knows
   *   whether Excel typed the cell as a date).
   */
  autoMapHeaders(
    headers: string[],
    columnValues?: ColumnValueEvidence
  ): Record<string, string> {
    return mapHeadersToFields(headers, columnValues);
  }

  /**
   * Maps one spreadsheet row onto a coin.
   *
   * `denomination` is copied from the file untouched; `denominationId` links to
   * the Denominations row that text names, when one can be resolved. The text is
   * never rewritten from the link (it is the record of what the file said). No
   * link is normal: the row still imports and displays e.g. `Other (8 Reales)`.
   * Only the 2-of-3 completeness rule decides whether a row is imported.
   *
   * @param denominations optional lookup list from `InventoryService.denominations()`;
   *   without it nothing links. The resolver index is built once per array
   *   (see denomination-index.ts).
   */
  mapRowToCoin(
    row: string[],
    headers: string[],
    mapping: Record<string, string>,
    denominations: readonly IndexableDenomination[] = [],
    catalogs: readonly CatalogOption[] = []
  ): CoinRecord {
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      denomination: '',
      // Explicit null: the record is POSTed as-is and later edits diff against it.
      // Only the resolution after the loop sets it (there is no Denomination Id column).
      denominationId: null,
      year: '',
      coinType: '',
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
      source: 'csv',
      hasCacSticker: false,
      // Explicit 'owned' when the sheet has no Status column. `storageLocation` has
      // no default: a coin whose file says nothing has no storage location.
      collectionStatus: 'owned'
    };

    for (let i = 0; i < headers.length; i++) {
      const field = mapping[headers[i]];
      const value = (row[i] ?? '').trim();
      if (!field || !value) continue;

      if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
        // Tolerates units, fractions and accounting negatives (see csv/numeric-cell.ts).
        (coin as unknown as Record<string, unknown>)[field] = parseNumericCell(value);
      } else if (field === 'collectionStatus') {
        // A closed set, so validate rather than copy. Anything unrecognised becomes
        // 'owned'; "For Sale" is accepted for the stored token 'for-sale'.
        coin.collectionStatus = normalizeCollectionStatus(value);
      } else if (field === 'catalogRefs') {
        // Several columns may map here; their references are combined.
        coin.catalogRefs = normalizeCatalogRefs([...(coin.catalogRefs ?? []), ...parseCatalogRefs(value, catalogs)]);
      } else if (field === 'source') {
        // Validate provenance; an unrecognised value becomes 'csv'.
        const normalized = value.toLowerCase();
        coin.source = (KNOWN_COIN_SOURCES.includes(normalized)
          ? normalized
          : 'csv') as CoinRecord['source'];
      } else {
        (coin as unknown as Record<string, unknown>)[field] = value;
      }
    }

     // After the loop, because it reads denomination and country. The row's own
     // country scopes the search, so it must not be replaced by a constant.
    coin.denominationId = resolveDenominationId(coin.denomination, coin.country, denominations);

    return coin;
  }

  /**
   * Export -> CSV header labels and field keys, derived from CSV_MAPPABLE_FIELDS
   * so every exported column is importable.
   */
  private exportColumns(): { key: keyof CoinRecord; label: string }[] {
    return CSV_MAPPABLE_FIELDS
      .filter(field => field.key)
      .map(field => ({ key: field.key as keyof CoinRecord, label: field.label }));
  }

  exportCsv(coins: CoinRecord[], catalogs: readonly CatalogOption[] = []): void {
    const columns = this.exportColumns();

    const lines = [columns.map(column => this.escapeCsvField(column.label)).join(',')];
    for (const coin of coins) {
      const row = columns.map(column => this.escapeCsvField(
        column.key === 'catalogRefs' ? formatCatalogRefs(catalogs, coin.catalogRefs) : coin[column.key] ?? ''
      ));
      lines.push(row.join(','));
    }

    this.downloadCsv(lines, 'coin-inventory.csv');
  }

  /** The export header row, exposed so tests can check every column round-trips. */
  exportHeaderLabels(): string[] {
    return this.exportColumns().map(column => column.label);
  }

  /**
   * Downloads a CSV template: the header row generated from CSV_MAPPABLE_FIELDS
   * plus two example coins.
   */
  downloadCsvTemplate(): void {
    // Every mappable field except the "(skip)" placeholder and `source` (hand-typed rows are 'csv').
    const templateFields = CSV_MAPPABLE_FIELDS.filter(
      field => field.key && field.key !== 'source'
    );

    // Example rows show Year as text ("1878-S"), currency formatting, and grams.
    // Keyed by field so adding a field can't shift values a column.
    const examples: Record<string, string>[] = [
      {
        coinType: 'Morgan Dollar', denomination: 'Dollar', year: '1881',
        category: 'Silver Dollars', country: 'United States', grade: 'MS63',
        certCompany: 'PCGS', certNumber: '12345678', variety: 'VAM-1A',
        mintMark: 'S', composition: '90% Silver', purchaseDate: '2024-03-15',
        purchasePrice: '$1,250.00', currentValue: '1400',
        notes: 'Rainbow toning',
        // Gross weight of a Morgan dollar in grams, with its unit.
        coinSet: 'Morgan Set', metalContent: 'Silver', weight: '26.73 g'
      },
      {
        coinType: 'Gold Eagle', denomination: '$5', year: '1996',
        category: 'Gold', country: 'United States', grade: 'MS69',
        certCompany: 'NGC', certNumber: '87654321', variety: '',
        mintMark: '', composition: '91.67% Gold', purchaseDate: '2023-11-02',
        purchasePrice: '$395.00', currentValue: '450',
        notes: 'Fractional bullion',
        // Gross weight of a 1/10 oz Gold Eagle (91.67% alloy). Not written as '1/10 oz':
        // the parser would read a tenth of a gram.
        coinSet: '', metalContent: 'Gold', weight: '3.393'
      }
    ];

    const lines = [templateFields.map(field => field.label).join(',')];
    for (const example of examples) {
      lines.push(
        templateFields
          .map(field => this.escapeCsvField(example[field.key] ?? ''))
          .join(',')
      );
    }

    this.downloadCsv(lines, 'coin-inventory-template.csv');
  }

  exportInsuranceCsv(coins: CoinRecord[]): void {
    const lines = ['Coin Type,Grade,Cert Company,Cert Number,Current Value,Purchase Price,Purchase Date,Notes'];
    for (const coin of coins) {
      lines.push([
        this.escapeCsvField(coin.coinType),
        this.escapeCsvField(coin.grade),
        this.escapeCsvField(coin.certCompany),
        this.escapeCsvField(coin.certNumber),
        coin.currentValue.toFixed(2),
        coin.purchasePrice.toFixed(2),
        this.escapeCsvField(coin.purchaseDate),
        this.escapeCsvField(coin.notes)
      ].join(','));
    }

    this.downloadCsv(lines, 'coin-insurance-schedule.csv');
  }

  private escapeCsvField(value: unknown): string {
    const str = value == null ? '' : String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  /**
   * Writes one of the CSV exports. All CSV output goes through here so it gets
   * the leading BOM (see csv/byte-order-mark.ts). The BOM is added here, above
   * `downloadBlob`, so specs that replace `downloadBlob` capture the exact file.
   */
  private downloadCsv(lines: string[], filename: string): void {
    this.downloadBlob(BOM + lines.join('\n'), filename, 'text/csv;charset=utf-8');
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
