import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CoinRecord } from '../../types/coin.model';
import { InventoryService } from '../../services/inventory.service';
import { CsvService, CSV_MAPPABLE_FIELDS } from '../../services/csv.service';
import { describeMissingCoinDetail, hasEnoughCoinDetail } from '../../services/coin-completeness';
// The ONE shared inference. `pmFieldsToFill` asks pm-reference.ts what the
// coin is made of and what it weighs, and hands back ONLY the fields that are
// currently blank -- which is exactly the rule a CSV import needs. See
// `enrichWithInferredAlloy` below.
import { pmFieldsToFill } from '../../services/pm-fill';
import { type ImportSource, planImport } from '../../services/csv/import-plan';
// "Has this record been sold?" and the one sentence that describes it, both
// taken from the module the QIF import also uses, so the tick box on this
// dialog cannot come to mean something different from the one on that.
import { SOLD_RULE_SENTENCE } from '../../services/import-sold';
// Value-aware auto-mapping. See services/csv/date-column-shape.ts: a column
// headed `Date` is a coin year over `1881` and a purchase date over
// `3/15/2024`, and only the cells can tell the two apart.
import {
  type ColumnValueEvidence,
  mergeColumnSamples,
  textColumnSamples
} from '../../services/csv/date-column-shape';
// TYPE-ONLY, and it has to stay that way. A value import of anything in
// services/xlsx/workbook-sheets would drag that module -- and through it
// workbook-cell-text -- into the INITIAL bundle, which is the one thing the
// dynamic import in loadWorkbook() exists to avoid. The initial bundle is
// already over its 500 kB warning budget.
import type { WorkbookSheet } from '../../services/xlsx/workbook-sheets';
import { compareSheetHeaders } from '../../services/xlsx/sheet-header-comparison';

/*
 * Excel import lives here, in the CSV modal, on purpose. `.xlsx` is not a
 * parallel path: services/xlsx/ produces the same `headers: string[]` +
 * `rows: string[][]` the CSV path has always produced, and from the mapping
 * grid down the code is shared. Do not split it into a second modal -- a copy
 * drifts, and two importers enforcing different completeness rules means the
 * same under-specified row is accepted on one path and refused on the other.
 * All a workbook adds here is a step in front: which worksheets, and a
 * warning when they do not agree.
 *
 * One mapping covers several sheets because it is a dictionary keyed by
 * HEADER TEXT, applied against each sheet's OWN header array. Two tabs that
 * both have a `Cost` column are one question rather than two; column order
 * never carries meaning; a column that exists on only one tab gets its own
 * entry and simply does not apply to the rest.
 */

/**
 * One row that was NOT imported because it lacked enough identifying detail,
 * kept so the user can be told exactly what happened to it.
 */
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
 * One column in the mapping grid.
 *
 * `sheets` and `onEverySheet` exist only to tell the user when a column is
 * not on every worksheet being imported. Mapping such a column is still
 * valid -- the rows that lack it just leave that field blank.
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
   * Which of the two Import menu entries opened this dialog.
   *
   * *** IT CHANGES WHAT THE DIALOG SAYS, NOT WHAT IT CAN READ. ***
   * The Import menu now offers "Excel" and "CSV" separately, because a user
   * holding a spreadsheet should find the word Excel in a list rather than
   * decode "Excel or CSV". Behind both is this one dialog, and it is the
   * same one on purpose: the two formats converge on a single `headers` +
   * `rows` shape and from the mapping grid down every rule is shared. Two
   * modals would be two copies of the completeness rule, which is how the
   * same under-specified row ends up accepted on one path and refused on
   * the other.
   *
   * So the mode sets the heading, the button text and the file picker's
   * SUGGESTED extensions — a hint to the file dialog, not a gate. A user who
   * picks "CSV" and then chooses an `.xlsx` still gets his workbook read:
   * `handleFileSelection` routes on the extension, and refusing a file this
   * dialog can plainly read in order to be right about a menu click would be
   * pedantry at the user's expense.
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

  /* Workbook-only state. Empty for a CSV, which is what makes every computed
   * below fall through to the csvHeaders/csvRows pair. */

  /** Every worksheet in the chosen workbook, INCLUDING ones that cannot be
   *  imported -- a tab that silently vanished from the list would read as a
   *  bug rather than as a decision. */
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

  /**
   * What will be imported, as one entry per worksheet (or one entry for a
   * CSV). This is the single seam between "where the data came from" and
   * everything below it.
   */
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
   * The cells the auto-mapper may look at when a heading is ambiguous,
   * pooled across everything currently selected and keyed by header text.
   *
   * Pooled on purpose: one mapping covers every ticked worksheet, so the
   * decision about a shared `Date` column has to be made on all of their
   * values. A tab whose Date column happens to be empty must not out-vote
   * the tab that shows what the column actually holds.
   *
   * The workbook branch uses the sheets' own samples rather than re-deriving
   * them from `source.rows`, because those samples still carry whether EXCEL
   * typed the cell as a date -- the one fact that flattening a worksheet to
   * `string[][]` destroys. The CSV branch has no types to lose.
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
   * What the import WOULD do, recomputed on every mapping change. The number
   * the button promises has to be one the import can deliver, so both come
   * from this one call. See services/csv/import-plan.ts.
   */
  /**
   * "Import only coins I still own."
   *
   * *** THE SAME OPTION, AND THE SAME DEFAULT, AS THE QUICKEN IMPORT. ***
   * It used to exist on the QIF dialog alone, which made "only unsold" a
   * property of one file format rather than of the import. A record counts
   * as sold when it has a sold date, a sold price or a buyer -- a rule a
   * spreadsheet can satisfy by mapping any one of those three columns. See
   * services/import-sold.ts.
   *
   * OFF BY DEFAULT: everything comes in, sold coins included, because a
   * coin the owner no longer has is still a coin he had.
   */
  protected readonly onlyUnsoldCoins = signal(false);

  /** The one sentence, shared with the Quicken dialog. */
  protected readonly soldRuleSentence = SOLD_RULE_SENTENCE;

  /**
   * Which of the three sold columns this file actually maps.
   *
   * Used only to tell the user when the tick box can have no effect: a
   * sheet with no sold column satisfies the rule nowhere, so ticking it
   * excludes nothing. Saying so is better than a control that silently
   * does nothing, and better than hiding the control, which would leave
   * the user wondering where the option went.
   */
  protected readonly mappedSoldFields = computed(() => {
    const mapped = new Set(Object.values(this.csvFieldMapping()));
    return ['soldDate', 'soldPrice', 'soldTo'].filter(field => mapped.has(field));
  });

  /** True when nothing in this file can ever mark a row as sold. */
  protected readonly hasNoSoldColumn = computed(() => this.mappedSoldFields().length === 0);

  /** The tick box. Nothing to refresh by hand -- `importPlan` reads the
   *  signal, so the preview and the button follow it. */
  protected setOnlyUnsoldCoins(value: boolean): void {
    this.onlyUnsoldCoins.set(value);
  }

  protected readonly importPlan = computed(() => planImport(
    this.importSources(),
    this.csvFieldMapping(),
    /* The denomination lookup goes in here, and this is the only place it
     * does. `mapRowToCoin` writes `denominationId` alongside the text, and it
     * can only do that if it is handed the table.
     *
     * The list is READ INSIDE the computed rather than captured once, so a
     * preview drawn before `GET /api/denominations` answered re-links itself
     * the moment the signal fills; capture it outside and a user who opened
     * this dialog during start-up gets an import that silently links nothing.
     *
     * Reading it here also means the preview and the import resolve through
     * the same call: `importCsv` imports `importPlan().accepted` rather than
     * re-mapping, so the two cannot disagree about which coins linked. */
    (row, headers, mapping) =>
      this.csvService.mapRowToCoin(row, headers, mapping, this.inv.denominations()),
    /* Read INSIDE the computed, like the denomination list above, so the
     * preview, the count on the button and the import itself all come from
     * one call and cannot disagree about which rows the tick box removed. */
    { excludeSold: this.onlyUnsoldCoins() }
  ));

  protected readonly plannedImportCount = computed(() => this.importPlan().acceptedCount);

  /**
   * How many of the rows that WILL be created carry a link to a known
   * denomination.
   *
   * Information, NEVER a warning. A row that links to nothing is an ordinary
   * import: the coin keeps the text the file gave and reads `Other (8
   * Reales)`. So no styling, no icon, no threshold -- it sits in the same
   * plain sentence as the rest of the summary. It earns its line because it
   * is the only cheap signal that a column has been mapped onto the wrong
   * field. See `ImportPlan.linkedDenominations`.
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

  /**
   * How the selected worksheets' columns differ, in sentences that name the
   * sheet and the column. See services/xlsx/sheet-header-comparison.ts for
   * why "columns are inconsistent" was not good enough.
   */
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

  /**
   * How many of the imported coins gained at least one Metal / Composition /
   * PM % / PM weight / Weight value that was not in the file. Reported back
   * to the user so the inference is visible rather than mysterious.
   */
  protected readonly enrichedCount = signal(0);

  /**
   * Downloads a starter CSV with the recognised header row and two example
   * coins, so a first-time user has something concrete to edit rather than
   * having to guess at the format.
   */
  protected downloadTemplate(): void {
    this.csvService.downloadCsvTemplate();
  }

  /**
   * The single file input's handler, for both formats.
   *
   * ONE PICKER, not one per format. Asking the user to first classify their
   * file as CSV or Excel and then find the matching button is a question
   * about our implementation. The extension decides which reader runs.
   */
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

  /**
   * The CSV branch. Deliberately private: there is one public entry point for
   * choosing a file, for the same reason Excel import is not a second modal.
   */
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
    // Set after the rows, so `columnValues()` can see them. A CSV cell is
    // text and nothing else, so the `Date`-column question is settled on
    // the patterns alone here.
    this.csvFieldMapping.set(this.csvService.autoMapHeaders(headers, this.columnValues()));
  }

  /**
   * Read a workbook and decide whether the user needs to be asked anything.
   *
   * The sheet step appears ONLY when there is more than one importable
   * worksheet; a single-sheet workbook goes straight to the mapping grid,
   * because a question with one possible answer is just a click.
   */
  private async loadWorkbook(file: File): Promise<void> {
    this.parsing.set(true);
    try {
      // Dynamically imported inside readWorkbook, so the parser is not part
      // of the initial bundle. See services/xlsx/read-workbook.ts.
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

      // Ticked by default: the sheets that look like inventory. A tab that
      // recognised nothing is still listed and still tickable -- a guess
      // about what counts as inventory is only a guess, and the user's
      // headings may simply be unusual.
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
      // Kept in workbook order rather than click order, so the mapping grid
      // and the preview read the same way round as the user's tabs.
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
   * Re-run auto-mapping over whatever columns are now in play, because
   * ticking another worksheet can introduce columns that were not there a
   * moment ago. Choices the user already made by hand are kept: a re-guess
   * that silently undid them would be worse than not re-guessing at all.
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
   * Map every row, then import only the rows that carry enough detail to be a
   * coin. The rest are reported, never silently dropped and never force-fed to
   * the backend.
   *
   * The 2-of-3 completeness rule (at least two of Year / Coin Type /
   * Denomination) is applied once, from the shared module both importers use,
   * so CSV and QIF cannot drift apart on it. It is not cosmetic: the backend
   * refuses a coin with no denomination with
   * `400 {"error":"denomination is required"}`, and a row that slips past
   * becomes an in-memory record with no database row behind it -- visible in
   * the grid, and failing every later edit against an id the server has never
   * seen. Rejected rows are listed rather than discarded, because the user
   * needs to know which lines of their file did not make it, and why.
   *
   * The verdict comes from `planImport`, the same call the preview renders,
   * so the number on the button is always a number the import can deliver.
   *
   * The only thing this method adds on top of the plan is the alloy
   * inference, which is deliberately NOT part of the plan: it fills blanks on
   * a finished record, has no bearing on the 2-of-3 verdict, and running it
   * over every row of a six-sheet workbook to draw a preview would be wasted
   * work.
   */
  protected importCsv(): void {
    const plan = this.importPlan();

    const accepted: CoinRecord[] = [];
    let enriched = 0;

    for (const mapped of plan.accepted) {
      // Work out Metal / Composition / PM % / PM weight / Weight for
      // anything the file did not already state. See the method below for
      // why this happens AFTER the completeness check and not before.
      const { coin, filledFields } = this.enrichWithInferredAlloy(mapped);
      if (filledFields > 0) enriched += 1;
      accepted.push(coin);
    }

    if (accepted.length > 0) this.inv.addCoins(accepted);

    this.importedCount.set(accepted.length);
    this.enrichedCount.set(enriched);
    this.csvExceptions.set(plan.rejected);

    // Closing on a clean import keeps the common case a single click. When
    // something was refused the dialog stays open, because a toast that
    // disappears is not an adequate way to tell someone which rows of their
    // file were skipped.
    if (plan.rejected.length === 0) this.close();
  }

  /**
   * Filling in what the spreadsheet did not say: Metal, Composition, PM % and
   * PM weight, worked out from country, denomination and year. Every import
   * path makes the same best effort, so two coins describing the same
   * physical object do not differ by which button was pressed.
   *
   * `pmFieldsToFill` (services/pm-fill.ts) rather than a second inference,
   * because it does the two things needed here: it asks `composePmFields` --
   * the shared entry point the Quicken import also calls -- what the coin is
   * made of, and it returns ONLY the fields currently blank on the record.
   *
   * That second part is what makes it safe on a freshly-mapped CSV row. A
   * value from the user's file is already on the record, so it is not blank,
   * so it is not in the returned object, so the spread CANNOT clobber it. The
   * user's own data outranks anything a table can work out, and that rule is
   * enforced in one place for all three import paths.
   *
   * The inference also reads what the file DID supply: a Metal column saying
   * "Gold" is passed down as a `metalHint` and settles cases the table
   * otherwise refuses -- an 1855 "$1" is a 24 g silver dollar or a 1.5 g gold
   * dollar, and nothing but the metal can say which.
   *
   * It runs AFTER the completeness check on purpose. The 2-of-3 rule must
   * judge the USER'S data; enriching first would not change today's verdict
   * (the rule reads Year / Coin Type / Denomination, none of which this
   * touches) but running it afterwards means it can never start to, and a
   * rejected row is reported exactly as the file wrote it.
   *
   * No new guessing: the refusals at the top of pm-reference.ts stand on this
   * path too -- the 1942 nickel, the 1982 cent, the 1971-78 Eisenhower, a
   * bare "$1" in the gold-dollar era. Those come out blank, because a wrong
   * purity produces a confidently wrong melt value and a blank does not.
   *
   * @returns the coin to import, and how many fields the inference added.
   *   The count is only used to tell the user what happened.
   */
  private enrichWithInferredAlloy(coin: CoinRecord): { coin: CoinRecord; filledFields: number } {
    // Blanks only -- see the long note above. `inferred` is already restricted
    // to fields this coin does not have, so the spread cannot clobber a value
    // that came out of the user's file.
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
