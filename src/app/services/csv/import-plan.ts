 /*
  * Decides which rows an import will create, before creating any.
  *
  * A coin needs at least two of Year / Coin Type / Denomination
  * (coin-completeness.ts). The backend also rejects a coin without a denomination
  * (`400 {"error":"denomination is required"}`), and the UI must never create a
  * coin the backend would reject (it would sit in the grid with no database row).
  * Running the rule up front means the Import button shows only rows that will be
  * created, and skipped rows are listed with reasons while the user can still fix
  * the mapping or the file.
  *
  * Row numbers restart at 1 on each sheet, matching what the user sees in the workbook.
  *
  * The mapping is keyed by header text and applied to each sheet's own headers,
  * so shared columns are decided once, column order doesn't matter, and a column
  * on only one sheet simply doesn't apply to the others. A heading that means
  * different things on two tabs can't be detected; import those tabs separately.
  */

import { CoinRecord } from '../../types/coin.model';
import { describeMissingCoinDetail, hasEnoughCoinDetail } from '../coin-completeness';
// Same "sold" rule as the QIF import (see import-sold.ts).
import { isSoldRecord } from '../import-sold';

/** One worksheet, or one CSV file, to be imported. */
export interface ImportSource {
  /** The worksheet's name; absent for a CSV. */
  sheetName?: string;
  headers: string[];
  rows: string[][];
}

/** A row that will not be imported, and why. */
export interface ImportRejection {
  /** The worksheet it is on; absent for a CSV. */
  sheetName?: string;
  /** 1-based position within its own sheet, heading row excluded. */
  rowNumber: number;
  /** Identifying text from the row, so the user can recognise it. */
  summary: string;
  /** Which of Year / Coin Type / Denomination are missing, in words. */
  missing: string;
}

/** Per-sheet tallies for the preview. */
export interface SheetTally {
  sheetName?: string;
  accepted: number;
  rejected: number;
  /** Of `accepted`, how many carry a `denominationId`. See ImportPlan. */
  linkedDenominations: number;
  /** Rows held back on this sheet because they are sold. */
  excludedAsSold: number;
}

export interface ImportPlanOptions {
  /**
   * Leave out sold rows (sold date, sold price or buyer; see import-sold.ts).
   * Default false: everything is imported, as in the Quicken import. Excluded
   * rows are counted in `excludedAsSold`.
   */
  excludeSold?: boolean;
}

export interface ImportPlan {
  /** The coins that will be created, in source order. */
  accepted: CoinRecord[];
  /** `accepted.length`, for templates. */
  acceptedCount: number;
  /** Rows that will be skipped, with reasons. */
  rejected: ImportRejection[];
  /** One tally per source, in the order they were given. */
  perSheet: SheetTally[];
  /** Rows held back by the "only coins I still own" option; 0 when off. Counted, not listed. */
  excludedAsSold: number;
   /*
    * Accepted rows linked to a known denomination. Informational only: an unlinked
    * row is a normal import (it keeps its text and displays as e.g.
    * `Other (8 Reales)`). Shown because it is a cheap check on the mapping: a
    * wrongly mapped Denomination column links nothing. Counted over `accepted` only.
    */
  linkedDenominations: number;
}

/**
 * Signature of `CsvService.mapRowToCoin`, passed in so this module stays a pure
 * function testable without Angular.
 */
export type RowMapper = (
  row: string[],
  headers: string[],
  mapping: Record<string, string>
) => CoinRecord;

/**
 * Short label for a rejected row: its identifying fields, or the first non-empty
 * cell when nothing mapped (usually a mapping problem).
 */
function describeRow(coin: CoinRecord, row: string[]): string {
  const parts = [coin.year, coin.coinType, coin.denomination].filter(part => part && part.trim());
  if (parts.length > 0) return parts.join(' ');

  const firstCell = row.find(cell => cell.trim());
  return firstCell ? firstCell.trim() : '(empty row)';
}

/**
 * Works out which rows would become coins, without creating any. Doesn't run
 * metal/composition inference; the importer applies that to accepted rows at
 * import time.
 */
export function planImport(
  sources: ImportSource[],
  mapping: Record<string, string>,
  mapRow: RowMapper,
  options?: ImportPlanOptions
): ImportPlan {
  const excludeSold = options?.excludeSold === true;
  const accepted: CoinRecord[] = [];
  const rejected: ImportRejection[] = [];
  const perSheet: SheetTally[] = [];
  let linkedDenominations = 0;
  let excludedAsSold = 0;

  for (const source of sources) {
    let sheetAccepted = 0;
    let sheetRejected = 0;
    let sheetLinked = 0;
    let sheetExcludedAsSold = 0;

    source.rows.forEach((row, index) => {
      const mapped = mapRow(row, source.headers, mapping);

      // The sold filter runs before the completeness rule: excluded sales are
      // counted, never listed as exceptions.
      if (excludeSold && isSoldRecord(mapped)) {
        excludedAsSold += 1;
        sheetExcludedAsSold += 1;
        return;
      }

      if (hasEnoughCoinDetail(mapped)) {
        accepted.push(mapped);
        sheetAccepted += 1;
        // Counted only; `mapRow` already resolved the id, so preview and import agree.
        if (mapped.denominationId !== null && mapped.denominationId !== undefined) {
          sheetLinked += 1;
          linkedDenominations += 1;
        }
      } else {
        rejected.push({
          ...(source.sheetName === undefined ? {} : { sheetName: source.sheetName }),
          rowNumber: index + 1,
          summary: describeRow(mapped, row),
          missing: describeMissingCoinDetail(mapped)
        });
        sheetRejected += 1;
      }
    });

    perSheet.push({
      ...(source.sheetName === undefined ? {} : { sheetName: source.sheetName }),
      accepted: sheetAccepted,
      rejected: sheetRejected,
      linkedDenominations: sheetLinked,
      excludedAsSold: sheetExcludedAsSold
    });
  }

  return {
    accepted,
    acceptedCount: accepted.length,
    rejected,
    perSheet,
    linkedDenominations,
    excludedAsSold
  };
}
