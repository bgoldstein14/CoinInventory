import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CoinRecord } from '../../types/coin.model';
import { InventoryService } from '../../services/inventory.service';
import { CsvService, CSV_MAPPABLE_FIELDS } from '../../services/csv.service';
import { describeMissingCoinDetail, hasEnoughCoinDetail } from '../../services/coin-completeness';
import { pmFieldsToFill } from '../../services/pm-fill';
import { type ImportSource, planImport } from '../../services/csv/import-plan';
// Shared with the QIF import so both "only unsold" options mean the same thing.
import { SOLD_RULE_SENTENCE } from '../../services/import-sold';
import {
  type ColumnValueEvidence,
  mergeColumnSamples,
  textColumnSamples
} from '../../services/csv/date-column-shape';
// Type-only: a value import would pull the workbook code into the initial
// bundle, which the dynamic import in loadWorkbook() exists to avoid.
import type { WorkbookSheet } from '../../services/xlsx/workbook-sheets';
import { compareSheetHeaders } from '../../services/xlsx/sheet-header-comparison';

/*
 * Handles both CSV and Excel. A workbook is converted to the same
 * headers + rows shape as a CSV, so everything from the mapping grid down is
 * shared; the workbook only adds a sheet-selection step. One mapping, keyed by
 * header text, applies to every selected sheet.
 */

/** A row that was not imported because it lacked identifying detail. */
interface CsvImportException {
  /** Which worksheet it was on. Absent for a CSV, which has no tabs. */
  sheetName?: string;
  /** 1-based position within its own sheet, heading row excluded. */
  rowNumber: number;
  /** What the mapping did manage to read, for recognising the row. */
  summary: string;
  /** Which of Year / Coin Type / Denomination were missing. */
  missing: string;
}

/**
 * One column in the mapping grid. `sheets`/`onEverySheet` flag columns that
 * are missing from some selected worksheets.
 */
interface MappableColumn {
  header: string;
  sheets: string[];
  onEverySheet: boolean;
}

/** Extensions routed to the workbook reader rather than the CSV parser. */
const WORKBOOK_EXTENSIONS = ['.xlsx', '.xlsm'];

@Component({
  selector: 'app-csv-import-modal',
  imports: [FormsModule],
  templateUrl: './csv-import-modal.html',
  styleUrl: './csv-import-modal.scss'
})
export class CsvImportModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly csvService = inject(CsvService);
  protected get inv() { return this.inventoryService; }

  readonly closed = output<void>();

  /**
   * Which Import menu entry opened the dialog. Changes the wording and the
   * suggested file extensions only; any supported file is still read.
   */
  readonly mode = input<'excel' | 'csv'>('excel');

  /** File-dialog suggestion only — see `mode`. Never used to reject a file. */
  protected readonly acceptedExtensions = computed(() =>
    this.mode() === 'csv' ? '.csv,.txt,.xlsx,.xlsm' : '.xlsx,.xlsm,.csv,.txt'
  );

  protected readonly heading = computed(() =>
    this.mode() === 'csv' ? 'Import from a CSV file' : 'Import from an Excel workbook'
  );

  protected readonly filePickerLabel = computed(() =>
    this.mode() === 'csv' ? 'Select CSV file' : 'Select Excel workbook'
  );

  readonly csvMappableFields = CSV_MAPPABLE_FIELDS;

  protected readonly csvHeaders = signal<string[]>([]);
  protected readonly csvRows = signal<string[][]>([]);
  protected readonly csvFieldMapping = signal<Record<string, string>>({});

  /* Workbook-only state; empty for a CSV. */

  /** Every worksheet in the workbook, including ones that cannot be imported. */
  protected readonly workbookSheets = signal<WorkbookSheet[]>([]);

  /** Which of them the user wants, by name. */
  protected readonly selectedSheetNames = signal<string[]>([]);

  /** True while the "which sheets?" step is on screen. */
  protected readonly showSheetPicker = signal(false);

  /** The file's name, for the dialog heading. */
  protected readonly fileName = signal('');

  /** Set while a workbook is being parsed; the file is read asynchronously. */
  protected readonly parsing = signal(false);

  /** A message about the FILE itself -- unreadable, empty, wrong format. */
  protected readonly fileError = signal('');

  /** The ticked sheets that actually have something in them. */
  protected readonly selectedSheets = computed(() =>
    this.workbookSheets().filter(
      sheet => sheet.importable && this.selectedSheetNames().includes(sheet.name)
    )
  );

  /** What will be imported: one entry per selected worksheet, or one for a CSV. */
  protected readonly importSources = computed<ImportSource[]>(() => {
    const sheets = this.selectedSheets();
    if (sheets.length > 0) {
      return sheets.map(sheet => ({
        sheetName: sheet.name,
        headers: sheet.headers,
        rows: sheet.rows
      }));
    }
    if (this.csvHeaders().length === 0) return [];
    return [{ headers: this.csvHeaders(), rows: this.csvRows() }];
  });

  /**
   * Sample cells per header, pooled across selected sheets, used by the
   * auto-mapper to resolve ambiguous headings such as `Date`. Workbook samples
   * are used as-is because they keep Excel's date typing.
   */
  protected readonly columnValues = computed<ColumnValueEvidence>(() => {
    const sheets = this.selectedSheets();
    if (sheets.length > 0) {
      return mergeColumnSamples(sheets.map(sheet => sheet.valueSamples));
    }
    if (this.csvHeaders().length === 0) return {};
    return textColumnSamples(this.csvHeaders(), this.csvRows());
  });

  /** True once there is something to map. */
  protected readonly hasFile = computed(() => this.importSources().length > 0);

  /** One dropdown per DISTINCT column heading, in first-seen order. */
  protected readonly mappableColumns = computed<MappableColumn[]>(() => {
    const sources = this.importSources();
    const columns = new Map<string, MappableColumn>();

    for (const source of sources) {
      for (const header of source.headers) {
        const existing = columns.get(header);
        if (existing) {
          if (source.sheetName && !existing.sheets.includes(source.sheetName)) {
            existing.sheets.push(source.sheetName);
          }
        } else {
          columns.set(header, {
            header,
            sheets: source.sheetName ? [source.sheetName] : [],
            onEverySheet: true
          });
        }
      }
    }

    for (const column of columns.values()) {
      column.onEverySheet = sources.length <= 1 || column.sheets.length === sources.length;
    }

    return [...columns.values()];
  });

  /** Total data rows across everything selected. */
  protected readonly csvPreviewCount = computed(() =>
    this.importSources().reduce((total, source) => total + source.rows.length, 0)
  );

  /**
   * "Import only coins I still own." Off by default. A row counts as sold when
   * it has a sold date, sold price or buyer (see services/import-sold.ts).
   */
  protected readonly onlyUnsoldCoins = signal(false);

  /** The one sentence, shared with the Quicken dialog. */
  protected readonly soldRuleSentence = SOLD_RULE_SENTENCE;

  /** Which sold columns are mapped; used to warn when the tick box can have no effect. */
  protected readonly mappedSoldFields = computed(() => {
    const mapped = new Set(Object.values(this.csvFieldMapping()));
    return ['soldDate', 'soldPrice', 'soldTo'].filter(field => mapped.has(field));
  });

  /** True when nothing in this file can ever mark a row as sold. */
  protected readonly hasNoSoldColumn = computed(() => this.mappedSoldFields().length === 0);

  protected setOnlyUnsoldCoins(value: boolean): void {
    this.onlyUnsoldCoins.set(value);
  }

  /**
   * What the import would do, recomputed on every change. The preview, the
   * button count and the import itself all use this one plan, so they always
   * agree (see services/csv/import-plan.ts).
   */
  protected readonly importPlan = computed(() => planImport(
    this.importSources(),
    this.csvFieldMapping(),
    // Denominations are read inside the computed so the plan re-links once
    // the list finishes loading.
    (row, headers, mapping) =>
      this.csvService.mapRowToCoin(row, headers, mapping, this.inv.denominations(), this.inv.catalogs()),
    { excludeSold: this.onlyUnsoldCoins() }
  ));

  protected readonly plannedImportCount = computed(() => this.importPlan().acceptedCount);

  /**
   * How many accepted rows link to a known denomination. Informational only;
   * unlinked rows import normally with their text.
   */
  protected readonly plannedLinkedCount = computed(() => this.importPlan().linkedDenominations);
  /** How many rows the sold filter held back. 0 while it is unticked. */
  protected readonly plannedSoldExclusions = computed(() => this.importPlan().excludedAsSold);
  protected readonly plannedSkips = computed(() => this.importPlan().rejected);
  protected readonly plannedSkipCount = computed(() => this.importPlan().rejected.length);

  /** Per-sheet tallies, shown when more than one sheet is being imported. */
  protected readonly plannedPerSheet = computed(() =>
    this.importSources().length > 1 ? this.importPlan().perSheet : []
  );

  /** Sentences describing how the selected worksheets' columns differ. */
  protected readonly sheetWarnings = computed(() =>
    compareSheetHeaders(
      this.workbookSheets()
        .filter(sheet => sheet.importable && this.selectedSheetNames().includes(sheet.name))
        .map(sheet => ({ name: sheet.name, headers: sheet.headers }))
    ).messages
  );

  /** Whether the sheet picker's Continue button should be live. */
  protected readonly canContinue = computed(() => this.selectedSheets().length > 0);

  /** Rows refused by the 2-of-3 completeness rule, shown after an import. */
  protected readonly csvExceptions = signal<CsvImportException[]>([]);

  /** How many rows actually made it in, shown alongside the exceptions. */
  protected readonly importedCount = signal(0);

  /** How many imported coins had metal/weight fields filled in by inference. */
  protected readonly enrichedCount = signal(0);

  /** Downloads a starter CSV with the recognised headers and two example coins. */
  protected downloadTemplate(): void {
    this.csvService.downloadCsvTemplate();
  }

  /** File input handler for both formats; the extension picks the reader. */
  protected async handleFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.resetLoadedFile();
    this.fileName.set(file.name);

    const lowerName = file.name.toLowerCase();
    if (WORKBOOK_EXTENSIONS.some(extension => lowerName.endsWith(extension))) {
      await this.loadWorkbook(file);
    } else {
      await this.loadCsv(file);
    }

    input.value = '';
  }

  /** Parse a CSV file and auto-map its headers. */
  private async loadCsv(file: File): Promise<void> {
    const text = await file.text();
    const rows = this.csvService.parseCsv(text);
    if (rows.length < 2) {
      this.fileError.set('That file has no rows under its heading row.');
      return;
    }

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim()));

    this.csvHeaders.set(headers);
    this.csvRows.set(dataRows);
    // After the rows are set, so columnValues() can see them.
    this.csvFieldMapping.set(this.csvService.autoMapHeaders(headers, this.columnValues()));
  }

  /**
   * Read a workbook. The sheet step is shown only when there is more than one
   * importable worksheet.
   */
  private async loadWorkbook(file: File): Promise<void> {
    this.parsing.set(true);
    try {
      // Loaded on demand so the parser is not part of the initial bundle.
      const { readWorkbook } = await import('../../services/xlsx/read-workbook');
      const sheets = await readWorkbook(await file.arrayBuffer());

      this.workbookSheets.set(sheets);

      const importable = sheets.filter(sheet => sheet.importable);
      if (importable.length === 0) {
        this.workbookSheets.set([]);
        this.fileError.set(
          'That workbook has no sheets with data under a heading row.'
        );
        return;
      }

      // Pre-tick sheets with recognised columns; the rest stay listed and tickable.
      const recognised = importable.filter(sheet => sheet.recognisedColumns > 0);
      const defaultSelection = recognised.length > 0 ? recognised : importable;
      this.selectedSheetNames.set(defaultSelection.map(sheet => sheet.name));

      this.showSheetPicker.set(importable.length > 1);
      this.refreshAutoMapping();
    } catch (error) {
      this.workbookSheets.set([]);
      this.selectedSheetNames.set([]);
      this.fileError.set(
        error instanceof Error
          ? error.message
          : 'That file could not be read as an Excel workbook.'
      );
    } finally {
      this.parsing.set(false);
    }
  }

  /* ---- The sheet step ---- */

  protected setSheetSelected(name: string, selected: boolean): void {
    const current = this.selectedSheetNames();
    if (selected && !current.includes(name)) {
      // Keep workbook order rather than click order.
      const order = this.workbookSheets().map(sheet => sheet.name);
      this.selectedSheetNames.set(
        [...current, name].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      );
    } else if (!selected) {
      this.selectedSheetNames.set(current.filter(sheetName => sheetName !== name));
    }
    this.refreshAutoMapping();
  }

  protected isSheetSelected(name: string): boolean {
    return this.selectedSheetNames().includes(name);
  }

  protected selectAllSheets(): void {
    this.selectedSheetNames.set(
      this.workbookSheets().filter(sheet => sheet.importable).map(sheet => sheet.name)
    );
    this.refreshAutoMapping();
  }

  protected clearSheetSelection(): void {
    this.selectedSheetNames.set([]);
    this.refreshAutoMapping();
  }

  protected continueToMapping(): void {
    if (!this.canContinue()) return;
    this.showSheetPicker.set(false);
  }

  /** Back to the sheet list without losing the file. */
  protected backToSheetPicker(): void {
    this.showSheetPicker.set(true);
  }

  /**
   * Re-run auto-mapping for the columns now in play, keeping any mappings the
   * user already chose.
   */
  private refreshAutoMapping(): void {
    const headers = this.mappableColumns().map(column => column.header);
    const guessed = this.csvService.autoMapHeaders(headers, this.columnValues());
    const existing = this.csvFieldMapping();

    const merged: Record<string, string> = { ...guessed };
    for (const [header, field] of Object.entries(existing)) {
      if (headers.includes(header)) merged[header] = field;
    }
    this.csvFieldMapping.set(merged);
  }

  /** Clear everything to do with the previously chosen file. */
  private resetLoadedFile(): void {
    this.csvHeaders.set([]);
    this.csvRows.set([]);
    this.csvFieldMapping.set({});
    this.workbookSheets.set([]);
    this.selectedSheetNames.set([]);
    this.showSheetPicker.set(false);
    this.fileError.set('');
    this.csvExceptions.set([]);
    this.importedCount.set(0);
    this.enrichedCount.set(0);
  }

  protected updateCsvMapping(csvHeader: string, coinField: string): void {
    this.csvFieldMapping.set({ ...this.csvFieldMapping(), [csvHeader]: coinField });
  }

  /**
   * Import the rows the plan accepted (at least two of Year / Coin Type /
   * Denomination) and list the rejected ones. The backend refuses a coin
   * without enough detail, so such rows are never sent. Alloy inference runs
   * here rather than in the plan because it does not affect acceptance.
   */
  protected importCsv(): void {
    const plan = this.importPlan();

    const accepted: CoinRecord[] = [];
    let enriched = 0;

    for (const mapped of plan.accepted) {
      const { coin, filledFields } = this.enrichWithInferredAlloy(mapped);
      if (filledFields > 0) enriched += 1;
      accepted.push(coin);
    }

    if (accepted.length > 0) this.inv.addCoins(accepted);

    this.importedCount.set(accepted.length);
    this.enrichedCount.set(enriched);
    this.csvExceptions.set(plan.rejected);

    // Stay open when rows were refused so the user can see which ones.
    if (plan.rejected.length === 0) this.close();
  }

  /**
   * Fill blank Metal / Composition / PM % / PM weight / Weight fields from
   * country, denomination and year via the shared pm-fill inference. Only
   * blank fields are returned, so values from the file are never overwritten.
   *
   * @returns the coin to import, and how many fields the inference added.
   */
  private enrichWithInferredAlloy(coin: CoinRecord): { coin: CoinRecord; filledFields: number } {
    const inferred = pmFieldsToFill(coin);
    const filledFields = Object.keys(inferred).length;
    if (filledFields === 0) return { coin, filledFields: 0 };

    return { coin: { ...coin, ...inferred }, filledFields };
  }

  close(): void {
    this.resetLoadedFile();
    this.fileName.set('');
    this.closed.emit();
  }
}
