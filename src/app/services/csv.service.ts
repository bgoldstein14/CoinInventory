import { Injectable } from '@angular/core';
import { CoinRecord } from '../types/coin.model';
import { parseNumericCell } from './csv/numeric-cell';
import { mapHeadersToFields } from './csv/header-synonyms';
import { ColumnValueEvidence } from './csv/date-column-shape';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';
import { BOM, stripBom } from './csv/byte-order-mark';
import { normalizeCollectionStatus } from '../types/collection-status';
// The ONE resolver. Not a second alias table, not a second set of rules --
// the same function the editor's picker and migration 014 answer with. See
// services/denominations/denomination-index.ts, and `mapRowToCoin` below.
import {
  resolveDenominationId,
  type IndexableDenomination
} from './denominations/denomination-index';

/**
 * The provenance values `CoinRecord.source` is allowed to hold.
 *
 * Needed because `Source` is now an importable column (see below), and a CSV
 * cell is just text — without this check a typo in that column would put an
 * arbitrary string into a field the rest of the app treats as a closed set.
 */
const KNOWN_COIN_SOURCES: readonly string[] = ['manual', 'quicken', 'import', 'csv'];

/**
 * Re-exported, not defined here. The list moved to csv/mappable-fields.ts to
 * break the import cycle with csv/header-synonyms.ts; see the comment at the
 * top of that file. Every existing
 * `import { CSV_MAPPABLE_FIELDS } from '.../csv.service'` keeps working.
 */
export { CSV_MAPPABLE_FIELDS };

@Injectable({ providedIn: 'root' })
export class CsvService {

  parseCsv(rawText: string): string[][] {
    // A leading byte-order mark belongs to the ENCODING, not to the first
    // header. Leaving it attached makes column one read `﻿Coin Type`,
    // which matches no field, so the column arrives unmapped on a screen
    // where everything else mapped correctly -- a blank dropdown nobody
    // notices. Our own exports now carry a BOM (without it Excel decodes `¢`
    // as `Â¢`; see csv/byte-order-mark.ts), and so do plenty of files written
    // by other programs.
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
   * Guess which coin field each column holds.
   *
   * The matching lives in csv/header-synonyms.ts, which keeps the exact,
   * case-insensitive key-or-label comparison as its most-confident tier and
   * adds a synonym tier beneath it -- without which a stranger's workbook
   * (`Yr`, `Cost`, `MM`, `TPG`, `Cert #`) arrives with thirty blank
   * dropdowns. Both import paths -- CSV and `.xlsx` -- call this one method,
   * so neither can drift ahead of the other.
   *
   * A header that cannot be placed is ABSENT from the returned dictionary,
   * which the mapping dropdown renders as "(skip)" for the user to set.
   * `Weight (oz)` and `Dealer` are refused -- see the long notes on
   * CSV_MAPPABLE_FIELDS above and in header-synonyms.ts.
   *
   * @param columnValues sampled cells per column, keyed by header text.
   *   Optional, and the whole reason it exists is the one heading the
   *   heading cannot settle: `Date`, which is a coin year over `1881` and a
   *   calendar date over `3/15/2024`. Build it with `textColumnSamples` for
   *   plain rows, or take `WorkbookSheet.valueSamples` for a workbook --
   *   the workbook form additionally carries whether Excel itself typed the
   *   cell as a date. Omit it and the guess is made on headings alone, as
   *   it always was.
   */
  autoMapHeaders(
    headers: string[],
    columnValues?: ColumnValueEvidence
  ): Record<string, string> {
    return mapHeadersToFields(headers, columnValues);
  }

  /**
   * One spreadsheet row, mapped onto a coin.
   *
   * ---- THE DENOMINATION IS NOW TWO FIELDS, AND THIS WRITES BOTH   (design §4.1) ----
   * `denomination` is WHAT THE FILE SAID and is copied across untouched, as
   * it always was. `denominationId` is the link to the Denominations row
   * that text names, when one can be established.
   *
   * *** THE TEXT IS NEVER REWRITTEN FROM THE LINK. *** Not trimmed into the
   * label, not replaced, not cleared when nothing matched. A column reading
   * `Pillar Dollar` that resolves to `8 Reales` keeps saying `Pillar
   * Dollar`, because that string is the only surviving record of what the
   * file contained and the input a later, smarter resolver would need. The
   * same rule binds migration 014 and the server bindings; it is what makes
   * the whole change recoverable.
   *
   * *** NO LINK IS A NORMAL OUTCOME, NOT AN ERROR. *** A value six issuers
   * struck, or one the seed has never heard of, resolves to nothing. The
   * row still imports, with its text, and reads `Other (8 Reales)`. Nothing
   * warns and nothing is rejected -- the 2-of-3 completeness rule is the
   * only gate on this path and resolution is deliberately not wired into
   * it.
   *
   * @param denominations the lookup list, straight from
   *   `InventoryService.denominations()`. OPTIONAL, and the default matters:
   *   every existing three-argument caller keeps working unchanged and
   *   simply links nothing, which is the honest result when there is no
   *   table to link against. The cost of passing it is one alias fold per
   *   row -- the index behind `resolveDenominationId` is built once per
   *   lookup array, not once per row. See denomination-index.ts.
   */
  mapRowToCoin(
    row: string[],
    headers: string[],
    mapping: Record<string, string>,
    denominations: readonly IndexableDenomination[] = []
  ): CoinRecord {
    const coin: CoinRecord = {
      id: crypto.randomUUID(),
      denomination: '',
      /* Spelled out as null rather than left undefined, like
       * `collectionStatus` below: this record is POSTed as-is and is the
       * snapshot later edits diff against, and "no link" is a real answer
       * about this coin rather than a field nobody got round to. The loop
       * below never writes it -- there is no mappable `Denomination Id`
       * column, deliberately -- so the only thing that sets it is the
       * resolution at the end. */
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
      // Spelled out rather than left undefined so that a sheet with no Status
      // column produces coins that are explicitly Owned. Both readings mean
      // the same thing to the app, but a row POSTed with the field present is
      // one fewer place relying on the normaliser to rescue it.
      //
      // `storageLocation` gets no default on purpose: the loop below only
      // writes fields the sheet actually supplied, and a coin whose file said
      // nothing about where it lives has no storage location -- not an empty
      // one. Status cannot work that way because it has a meaningful default.
      collectionStatus: 'owned'
    };

    for (let i = 0; i < headers.length; i++) {
      const field = mapping[headers[i]];
      const value = (row[i] ?? '').trim();
      if (!field || !value) continue;

      if (field === 'purchasePrice' || field === 'currentValue' || field === 'soldPrice' || field === 'weight') {
        // parseNumericCell tolerates the decoration people actually type -- a
        // unit on a weight ("26.73 g"), a fraction ("1/10"), a currency word,
        // an accounting negative. A plain
        // `Number(v.replace(/[$,]/g,'')) || 0` turns every one of those into
        // a silent 0. See csv/numeric-cell.ts.
        (coin as unknown as Record<string, unknown>)[field] = parseNumericCell(value);
      } else if (field === 'collectionStatus') {
        // A CLOSED SET, SO VALIDATE RATHER THAN COPY -- exactly as `source`
        // is handled directly below, and for a sharper reason.
        //
        // Five tokens decide whether a coin counts towards the value of the
        // collection. A cell reading "maybe" or "Wish List" copied straight
        // into the record would be a sixth value that nothing downstream has
        // a rule for, and `isHeldInCollection` would have to invent an answer
        // about a coin the owner really does have.
        //
        // normalizeCollectionStatus() answers 'owned' for anything it does
        // not recognise -- a typo, a word from a future build, a heading row
        // that slipped into the data. Owned is the safe fallback because the
        // coin is in a file the owner is importing INTO his collection.
        // It also accepts "For Sale" for the stored token 'for-sale', so the
        // words a human reads in the grid are the words he can type.
        coin.collectionStatus = normalizeCollectionStatus(value);
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

     /*
     * AFTER the loop, because it reads two fields the loop fills in.
     *
     * `coin.country` is THIS ROW'S country -- the file's Country column if
     * one was mapped, and otherwise the mapper's own 'United States'
     * default. Passing the row's own value rather than a constant is not a
     * detail: the country scopes the search before it widens, so a row that
     * says Mexico resolves an `8 Reales` that six issuers struck, and the
     * same row with the country thrown away does not.
      */
    coin.denominationId = resolveDenominationId(coin.denomination, coin.country, denominations);

    return coin;
  }

  /**
   * Build the header labels and matching field keys used by Export -> CSV.
   *
   * DERIVED from CSV_MAPPABLE_FIELDS rather than written out again, and that
   * is the point. Two hand-maintained parallel arrays -- one of labels, one
   * of keys -- drift: the export once grew a `Source` column that was never
   * added to the mappable list, so the file the app recommends as a
   * ready-made template contained a column the importer could not map.
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

    this.downloadCsv(lines, 'coin-inventory.csv');
  }

  /**
   * The header row Export -> CSV writes, exposed so tests can prove that every
   * exported column round-trips through autoMapHeaders(). Keeping it private
   * makes that mismatch untestable.
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
    // Keyed by field rather than written as positional arrays: a positional
    // array has to be kept in the same order and length as
    // CSV_MAPPABLE_FIELDS by hand, so adding one field silently shifts every
    // example value one column to the left. Looking each value up by key
    // makes that impossible -- a field with no example here comes out blank.
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
        // Do NOT write this as '1/10 oz': parseNumericCell resolves a
        // fraction ("1/10" -> 0.1), so in a GRAMS column that cell quietly
        // means a tenth of a gram. The template must not demonstrate a form
        // that is a trap in this column.
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
   * Write one of the three CSV exports to disk.
   *
   * EVERY CSV THIS APP PRODUCES GOES THROUGH HERE, and the reason is the
   * leading byte-order mark. Without it Excel decodes the file with the
   * machine's ANSI codepage rather than UTF-8, and `½ Cent` arrives as
   * `Â½ Cent`. See csv/byte-order-mark.ts, including why the importer had to
   * learn to strip one at the same time.
   *
   * The BOM is prepended HERE rather than inside `downloadBlob` so that the
   * tests see it. `downloadBlob` touches `document`, so specs replace it
   * wholesale and capture its `content` argument; if the BOM were added
   * below this line, every captured "exported file" would be missing the one
   * character under test and no round-trip test could ever catch its
   * absence. Adding it above the seam means the captured string is
   * byte-for-byte the file.
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
