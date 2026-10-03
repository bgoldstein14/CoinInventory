import { Injectable } from '@angular/core';
import { CoinRecord } from '../types/coin.model';
import { parseNumericCell } from './csv/numeric-cell';

/**
 * The provenance values `CoinRecord.source` is allowed to hold.
 *
 * Needed because `Source` is now an importable column (see below), and a CSV
 * cell is just text — without this check a typo in that column would put an
 * arbitrary string into a field the rest of the app treats as a closed set.
 */
const KNOWN_COIN_SOURCES: readonly string[] = ['manual', 'quicken', 'import', 'csv'];

export const CSV_MAPPABLE_FIELDS: { key: string; label: string }[] = [
  { key: '', label: '(skip)' },
  { key: 'coinType', label: 'Coin Type' },
  { key: 'denomination', label: 'Denomination' },
  { key: 'year', label: 'Year' },
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
  // A `{ key: 'dealer', label: 'Dealer' }` entry sat here. The coin-level
  // dealer field was removed, and because this one list drives the importer's
  // auto-mapping, the Export -> CSV columns AND the blank template, deleting it
  // here removes the Dealer column from all three at once. An older file that
  // still carries a Dealer column simply has no field to map it onto now, so it
  // is left unmapped and ignored -- the rest of the row imports normally.
  { key: 'coinSet', label: 'Set' },
  { key: 'metalContent', label: 'Metal Content' },
  // GRAMS, not troy ounces. This label was `Weight (oz)` until the gross
  // Weight column was switched to grams (see
  // server/migrations/008-weight-to-grams.sql). Because this one list drives
  // three things at once -- the Export -> CSV header, the blank template, and
  // the importer's auto-mapping -- changing the label here changes all three.
  //
  // *** OLD EXPORTS WILL NOT AUTO-MAP, AND THAT IS THE INTENDED BEHAVIOUR. ***
  //
  // autoMapHeaders() matches a header against each field's key or its label,
  // case-insensitively. A file exported before this change has a column headed
  // `Weight (oz)`, which now matches neither `weight` nor `Weight (g)`, so it
  // arrives at the mapping screen UNMAPPED. (A header of plain `Weight` still
  // maps, via the key.)
  //
  // Two alternatives were considered and rejected:
  //
  //   Recognise `Weight (oz)` and map it straight onto `weight`.
  //     This is the worst option available. The numbers under that header are
  //     troy ounces, so it would import a Morgan dollar as 0.7734 GRAMS -- a
  //     31x understatement that looks entirely plausible, silently, with no
  //     warning anywhere. It is the exact failure the migration exists to
  //     prevent, reintroduced through the back door.
  //
  //   Recognise `Weight (oz)` and multiply by 31.1034768 on the way in.
  //     Arithmetically right, and still rejected: it makes the meaning of a
  //     cell depend on the text in the header, which nobody expects. Somebody
  //     who has already converted their spreadsheet to grams but left the old
  //     header alone would get every weight multiplied by 31 instead, and
  //     there is no way for the importer to tell the two files apart. A
  //     silent 31x error in either direction is worse than a column the user
  //     has to look at.
  //
  // Leaving it unmapped is the honest option, and the cost is small and
  // visible: the mapping screen shows the column with no field chosen, and the
  // user either picks `Weight (g)` by hand (if the numbers are already grams)
  // or fixes the numbers first. Nothing else about the row is affected -- the
  // rest of it imports normally. This is the same precedent the removed
  // `Dealer` column set above: an unrecognised column is ignored, loudly
  // enough to be noticed on the mapping screen, rather than guessed at.
  { key: 'weight', label: 'Weight (g)' },
  { key: 'soldPrice', label: 'Sold Price' },
  { key: 'soldDate', label: 'Sold Date' },
  // `Source` is here so that Export -> CSV actually round-trips.
  //
  // exportCsv() has always written a Source column, but it was missing from
  // this list, which meant a freshly exported file could not be fully
  // re-imported: the column did not auto-map, and because the mapping dropdown
  // is built from this same list, it could not even be mapped by hand. So the
  // one file advertised as a ready-made template was the one file with an
  // unmappable column in it.
  //
  // Importing it also PRESERVES provenance rather than flattening it: a coin
  // that originally came from Quicken stays marked 'quicken' through an export
  // and re-import, instead of every row being relabelled 'csv'. Unrecognised
  // or blank values still fall back to 'csv' -- see mapRowToCoin().
  { key: 'source', label: 'Source' }
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
      denomination: '',
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
      hasCacSticker: false
    };

    for (let i = 0; i < headers.length; i++) {
      const field = mapping[headers[i]];
      const value = (row[i] ?? '').trim();
      if (!field || !value) continue;

      if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
        // parseNumericCell tolerates the decoration people actually type -- a
        // unit on a weight ("26.73 g"), a fraction ("1/10"), a currency word,
        // an accounting negative. The previous
        // `Number(v.replace(/[$,]/g,'')) || 0` turned every one of those into
        // a silent 0. See csv/numeric-cell.ts.
        (coin as unknown as Record<string, unknown>)[field] = parseNumericCell(value);
      } else if (field === 'source') {
        // Provenance is a closed set, so validate rather than trust the cell.
        // An unrecognised value means this row's origin is unknown to us, and
        // 'csv' is the truthful answer for a row that arrived in a CSV.
        const normalized = value.toLowerCase();
        coin.source = (KNOWN_COIN_SOURCES.includes(normalized)
          ? normalized
          : 'csv') as CoinRecord['source'];
      } else {
        (coin as unknown as Record<string, unknown>)[field] = value;
      }
    }

    return coin;
  }

  /**
   * Build the header labels and matching field keys used by Export -> CSV.
   *
   * DERIVED from CSV_MAPPABLE_FIELDS rather than written out again, and that is
   * the point. These used to be two hand-maintained parallel arrays -- one of
   * labels, one of keys -- kept in step with the mappable list by nothing but
   * care. They drifted: the export grew a `Source` column that was never added
   * to the mappable list, so the file the app recommends as a ready-made
   * template contained a column the importer could not map at all, by hand or
   * otherwise.
   *
   * Deriving both sides from one list makes that impossible. Anything
   * exportable is importable by construction, and adding a field in one place
   * updates the export, the auto-mapping and the blank template together.
   */
  private exportColumns(): { key: keyof CoinRecord; label: string }[] {
    return CSV_MAPPABLE_FIELDS
      .filter(field => field.key)
      .map(field => ({ key: field.key as keyof CoinRecord, label: field.label }));
  }

  exportCsv(coins: CoinRecord[]): void {
    const columns = this.exportColumns();

    const lines = [columns.map(column => this.escapeCsvField(column.label)).join(',')];
    for (const coin of coins) {
      const row = columns.map(column => this.escapeCsvField(coin[column.key] ?? ''));
      lines.push(row.join(','));
    }

    this.downloadBlob(lines.join('\n'), 'coin-inventory.csv', 'text/csv');
  }

  /**
   * The header row Export -> CSV writes, exposed so tests can prove that every
   * exported column round-trips through autoMapHeaders(). Without this the
   * header list was private and the export/import mismatch was untestable,
   * which is a large part of why it went unnoticed.
   */
  exportHeaderLabels(): string[] {
    return this.exportColumns().map(column => column.label);
  }

  /**
   * Downloads an empty CSV containing just the header row this importer
   * recognises, plus two example coins.
   *
   * WHY: there is no fixed CSV schema — the importer maps whatever columns
   * you give it. That flexibility is good, but it left new users with no
   * idea what to actually type. Rather than document a column list that can
   * drift out of date, this generates the header row FROM the same
   * CSV_MAPPABLE_FIELDS list the importer uses, so the template is always
   * correct by construction.
   */
  downloadCsvTemplate(): void {
    // Every mappable field except the leading "(skip)" placeholder and
    // `source`. Source is importable so that an exported file round-trips, but
    // it records where a coin's data CAME from, which is not something anyone
    // filling in a blank template should be asked to supply -- rows they type
    // by hand are, correctly, 'csv'.
    const templateFields = CSV_MAPPABLE_FIELDS.filter(
      field => field.key && field.key !== 'source'
    );

    // Two realistic rows so the expected shape of each column is obvious --
    // especially that Year is text (so "1878-S" is legal), that prices may
    // carry currency formatting, and that a weight is in grams and may carry
    // its unit.
    //
    // Keyed by field rather than written as positional arrays. The arrays that
    // used to live here had to be kept in the same order and length as
    // CSV_MAPPABLE_FIELDS by hand, so adding one field silently shifted every
    // example value one column to the left. Looking each value up by key makes
    // that impossible: a field with no example here simply comes out blank.
    const examples: Record<string, string>[] = [
      {
        coinType: 'Morgan Dollar', denomination: 'Dollar', year: '1881',
        category: 'Silver Dollars', country: 'United States', grade: 'MS63',
        certCompany: 'PCGS', certNumber: '12345678', variety: 'VAM-1A',
        mintMark: 'S', composition: '90% Silver', purchaseDate: '2024-03-15',
        purchasePrice: '$1,250.00', currentValue: '1400',
        notes: 'Rainbow toning',
        // Weight is the coin's GROSS weight in GRAMS. 26.73 g is the catalogue
        // weight of a Morgan dollar. It carries its unit here on purpose, to
        // show that a unit suffix is tolerated -- and, now that the column is
        // grams, to make the unit unmissable in the one file people copy.
        coinSet: 'Morgan Set', metalContent: 'Silver', weight: '26.73 g'
      },
      {
        coinType: 'Gold Eagle', denomination: '$5', year: '1996',
        category: 'Gold', country: 'United States', grade: 'MS69',
        certCompany: 'NGC', certNumber: '87654321', variety: '',
        mintMark: '', composition: '91.67% Gold', purchaseDate: '2023-11-02',
        purchasePrice: '$395.00', currentValue: '450',
        notes: 'Fractional bullion',
        // 3.393 g is the GROSS weight of a 1/10 oz Gold Eagle -- the coin
        // contains 1/10 troy oz (3.110 g) of gold, but it is a 91.67% alloy,
        // so the whole coin weighs more than its gold content.
        //
        // This example used to read '1/10 oz'. It was changed, and not only
        // because the unit changed: parseNumericCell still resolves a fraction
        // ("1/10" -> 0.1), so that cell would now quietly mean a tenth of a
        // GRAM. The template must not demonstrate a form that is a trap in
        // this column.
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

    this.downloadBlob(lines.join('\n'), 'coin-inventory-template.csv', 'text/csv');
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
