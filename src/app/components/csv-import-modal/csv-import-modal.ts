import { Component, computed, inject, output, signal } from '@angular/core';
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

/**
 * One CSV row that was NOT imported because it lacked enough identifying
 * detail, kept so the user can be told exactly what happened to it.
 */
interface CsvImportException {
  /** 1-based position in the file as the user sees it, header row excluded. */
  rowNumber: number;
  /** What the mapping did manage to read, for recognising the row. */
  summary: string;
  /** Which of Year / Coin Type / Denomination were missing. */
  missing: string;
}

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

  readonly csvMappableFields = CSV_MAPPABLE_FIELDS;

  protected readonly csvHeaders = signal<string[]>([]);
  protected readonly csvRows = signal<string[][]>([]);
  protected readonly csvFieldMapping = signal<Record<string, string>>({});

  protected readonly csvPreviewCount = computed(() => this.csvRows().length);

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

  protected async handleCsvFileSelection(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const rows = this.csvService.parseCsv(text);
    if (rows.length < 2) return;

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim()));

    this.csvHeaders.set(headers);
    this.csvRows.set(dataRows);
    this.csvFieldMapping.set(this.csvService.autoMapHeaders(headers));
    input.value = '';
  }

  protected updateCsvMapping(csvHeader: string, coinField: string): void {
    this.csvFieldMapping.set({ ...this.csvFieldMapping(), [csvHeader]: coinField });
  }

  /**
   * Map every row, then import only the rows that carry enough detail to be a
   * coin. The rest are reported, never silently dropped and never force-fed to
   * the backend.
   *
   * ---------------------------------------------------------------------------
   * WHY THE COMPLETENESS CHECK IS HERE
   * ---------------------------------------------------------------------------
   * This used to be `addCoins(rows.map(mapRowToCoin))` — every row, no questions
   * asked. QIF import has required at least two of Year / Coin Type /
   * Denomination for some time, but CSV never did, so the same under-specified
   * record was accepted on one path and refused on the other.
   *
   * That inconsistency was not harmless. The backend rejects a coin with no
   * denomination with `400 {"error":"denomination is required"}`, so such a row
   * became an in-memory record with no database row behind it. It showed up in
   * the grid, and then every edit to it failed against an id the server had
   * never seen. The user reported exactly this symptom on the QIF side and asked
   * for it to be impossible: the code should simply not import something it
   * cannot identify.
   *
   * So the rule is applied once, from the shared module both importers use, and
   * the rejected rows are listed rather than discarded — the user needs to know
   * which lines of their file did not make it, and why.
   */
  protected importCsv(): void {
    const headers = this.csvHeaders();
    const mapping = this.csvFieldMapping();

    const accepted: CoinRecord[] = [];
    const rejected: CsvImportException[] = [];
    let enriched = 0;

    this.csvRows().forEach((row, index) => {
      const mapped = this.csvService.mapRowToCoin(row, headers, mapping);

      if (hasEnoughCoinDetail(mapped)) {
        // Work out Metal / Composition / PM % / PM weight / Weight for
        // anything the file did not already state. See the method below for
        // why this happens AFTER the completeness check and not before.
        const { coin, filledFields } = this.enrichWithInferredAlloy(mapped);
        if (filledFields > 0) enriched += 1;
        accepted.push(coin);
      } else {
        rejected.push({
          rowNumber: index + 1,
          summary: this.describeRow(mapped, row),
          missing: describeMissingCoinDetail(mapped)
        });
      }
    });

    if (accepted.length > 0) this.inv.addCoins(accepted);

    this.importedCount.set(accepted.length);
    this.enrichedCount.set(enriched);
    this.csvExceptions.set(rejected);

    // Closing on a clean import keeps the common case a single click. When
    // something was refused the dialog stays open, because a toast that
    // disappears is not an adequate way to tell someone which rows of their
    // file were skipped.
    if (rejected.length === 0) this.close();
  }

  /* =========================================================================
   * FILLING IN WHAT THE SPREADSHEET DID NOT SAY
   * =========================================================================
   * THE DEFECT THIS FIXES
   * A coin imported from Quicken has had its Metal, Composition, PM % and PM
   * weight worked out from its country, denomination and year since that
   * feature shipped. A coin imported from CSV got NOTHING -- `mapRowToCoin`
   * copies cells across and stops. Two coins describing the same physical
   * object therefore ended up looking completely different depending on which
   * button the owner happened to press, and the CSV one showed a blank melt
   * value forever after. His instruction was that EVERY import path should
   * make the same best effort.
   *
   * ---------------------------------------------------------------------------
   * WHY `pmFieldsToFill` AND NOT A SECOND INFERENCE
   * ---------------------------------------------------------------------------
   * `pmFieldsToFill` (services/pm-fill.ts) is the function the Settings
   * backfill already uses. It does exactly two things, and they are precisely
   * the two things needed here:
   *
   *   1. it asks `composePmFields` -- the single shared entry point that the
   *      Quicken import also calls -- what the coin is made of; and
   *   2. it returns ONLY the fields that are currently blank on the record.
   *
   * Point 2 is what makes it safe to apply to a freshly-mapped CSV row. A
   * value that came out of the user's file is already sitting on the record
   * by the time this runs, so it is not blank, so it is not in the returned
   * object, so it CANNOT be overwritten. The user typed it deliberately and
   * it outranks anything a table can work out. That rule is enforced in one
   * place for all three import paths rather than re-implemented here, which
   * is the whole reason this method is four lines long.
   *
   * It also means the inference reads what the file DID supply: if the
   * spreadsheet has a Metal column saying "Gold", that value is passed down
   * as a `metalHint` and settles cases the table otherwise refuses -- an 1855
   * "$1", for instance, which is a 24 g silver dollar or a 1.5 g gold dollar
   * and nothing but the metal can say which.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS RUNS *AFTER* THE COMPLETENESS CHECK
   * ---------------------------------------------------------------------------
   * The 2-of-3 rule asks "is this row identifiable as a coin?", and it must
   * answer that about the USER'S data. Enriching first would not actually
   * change the verdict today (the rule reads Year / Coin Type / Denomination,
   * none of which this touches), but running it afterwards means it can never
   * start to: a rejected row is reported exactly as the file wrote it.
   *
   * ---------------------------------------------------------------------------
   * WHAT IS DELIBERATELY NOT DONE
   * ---------------------------------------------------------------------------
   * No new guessing. The refusals listed at the top of pm-reference.ts stand
   * unchanged on this path -- the 1942 nickel, the 1982 cent, the 1971-78
   * Eisenhower, a bare "$1" in the gold-dollar era. A CSV row for any of
   * those comes out with the fields blank, exactly as a QIF one does, because
   * a wrong purity produces a confidently wrong melt value and a blank does
   * not.
   *
   * @returns the coin to import, and how many fields the inference added.
   *   The count is only used to tell the user what happened; nothing branches
   *   on it.
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

  /**
   * A short human label for a rejected row: whatever identifying fields were
   * read, or the row's first non-empty cell when nothing useful was mapped at
   * all (which usually means the mapping itself is wrong).
   */
  private describeRow(coin: CoinRecord, row: string[]): string {
    const parts = [coin.year, coin.coinType, coin.denomination].filter(part => part && part.trim());
    if (parts.length > 0) return parts.join(' ');

    const firstCell = row.find(cell => cell.trim());
    return firstCell ? firstCell.trim() : '(empty row)';
  }

  close(): void {
    this.csvHeaders.set([]);
    this.csvRows.set([]);
    this.csvFieldMapping.set({});
    this.csvExceptions.set([]);
    this.importedCount.set(0);
    this.enrichedCount.set(0);
    this.closed.emit();
  }
}
