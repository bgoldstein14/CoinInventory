 /*
 * import-plan.ts — deciding what an import will create, before it creates it.
 * ---- THE RULE THIS SERVES ----
 * A coin needs at least two of Year / Coin Type / Denomination to be a coin
 * record rather than a fragment (services/coin-completeness.ts). The backend
 * refuses one with no denomination outright -- `400 {"error":"denomination
 * is required"}` -- and this project has a hard-won rule that the UI must
 * never offer to create a coin the backend would reject. When it does, the
 * row becomes an in-memory record with no database row behind it: visible in
 * the grid, and every subsequent edit failing against an id the server has
 * never seen.
 *
 * ---- WHY THE CHECK RUNS UP FRONT ----
 * Applying the rule only on the way past gives a button that says "Import
 * 412 rows" and a dialog that afterwards admits 37 were skipped -- a promise
 * the import could not deliver, discovered too late to act on cheaply. A
 * workbook makes it worse: with six worksheets, "37 rows were skipped" does
 * not say which tab to look at, and an import that cannot be previewed is
 * one somebody eventually runs twice.
 *
 * So the same rule, from the same shared module, runs before the import. The
 * button promises only what will actually be created, and the rows that will
 * be skipped are listed with their reason while the user can still act on it
 * -- map another column, or go and fix the file.
 *
 * ---- ROW NUMBERS RESTART ON EACH SHEET ----
 * Because that is how the user will find the row: they will open the tab and
 * scroll to it. A running total across sheets would be a number that appears
 * nowhere in their workbook.
 *
 * ---- ONE MAPPING, MANY SHEETS ----
 * The mapping is a dictionary keyed by HEADER TEXT, and each sheet is
 * applied against ITS OWN header array. Three things fall out of that, and
 * they are the reason multi-sheet import needs no extra machinery:
 *
 *   - Two sheets that both have a `Cost` column share the one decision, so
 *     the user answers each question once rather than once per tab.
 *   - A sheet whose columns are in a different ORDER still imports
 *     correctly, because position is never used to carry meaning.
 *   - A column that exists on only one sheet gets its own entry and simply
 *     does not apply to the others.
 *
 * The one case it does not cover is the same heading meaning different
 * things on two tabs -- a `Value` column that is melt value on one sheet and
 * retail on another. Nothing in a file can distinguish those, the user can,
 * and they can still import such tabs one at a time.
  */

import { CoinRecord } from '../../types/coin.model';
import { describeMissingCoinDetail, hasEnoughCoinDetail } from '../coin-completeness';
// "Has this record been sold?" -- the rule the QIF import uses too, so
// "import only coins I still own" means one thing on all three paths. A sold
// price of 0 counts; a whitespace-only buyer does not. See import-sold.ts.
import { isSoldRecord } from '../import-sold';

/** One worksheet, or one CSV file, to be imported. */
export interface ImportSource {
  /** The worksheet's name. Absent for a single CSV, which has no tabs. */
  sheetName?: string;
  headers: string[];
  rows: string[][];
}

/** A row that will NOT be imported, and why. */
export interface ImportRejection {
  /** Which worksheet it is on. Absent for a CSV. */
  sheetName?: string;
  /** 1-based position within its own sheet, heading row excluded. */
  rowNumber: number;
  /** Whatever identifying text could be read, for recognising the row. */
  summary: string;
  /** Which of Year / Coin Type / Denomination are missing, in words. */
  missing: string;
}

/** Per-sheet tallies, so the preview can summarise without re-counting. */
export interface SheetTally {
  sheetName?: string;
  accepted: number;
  rejected: number;
  /** Of `accepted`, how many carry a `denominationId`. See ImportPlan. */
  linkedDenominations: number;
  /** Rows this sheet held back because they are sold. See ImportPlan. */
  excludedAsSold: number;
}

/** What the caller may switch on for one plan. */
export interface ImportPlanOptions {
  /**
   * Leave out rows that have been SOLD -- the record has a sold date, a
   * sold price or a buyer (services/import-sold.ts).
   *
   * *** DEFAULT FALSE: EVERYTHING COMES IN, SOLD COINS INCLUDED. ***
   * The same default, and the same tick box, as the Quicken import. A coin
   * the owner no longer has is still a coin he had, and what he paid and
   * what he got for it is the part he wants to report on. Narrowing to the
   * current holding is the deliberate act, and the rows it holds back are
   * counted in `excludedAsSold` rather than vanishing.
   *
   * A file that maps none of the three columns satisfies the rule nowhere,
   * so switching this on changes nothing -- which is the honest outcome and
   * is why the dialog says so rather than hiding the option.
   */
  excludeSold?: boolean;
}

export interface ImportPlan {
  /** The coins that will be created, in source order. */
  accepted: CoinRecord[];
  /** `accepted.length`, so a template can read it without a function call. */
  acceptedCount: number;
  /** Rows that will be skipped, with reasons. */
  rejected: ImportRejection[];
  /** One tally per source, in the order they were given. */
  perSheet: SheetTally[];
  /**
   * How many rows the "only coins I still own" option held back.
   *
   * Always 0 when the option is off, because then nothing is being held
   * back. Counted rather than listed: unlike a row refused for want of
   * detail, an excluded sale is exactly what the user asked for, and the
   * only thing worth saying is how many -- so the number on the button is
   * never a surprise.
   */
  excludedAsSold: number;
   /*
   * HOW MANY ACCEPTED ROWS LINKED TO A KNOWN DENOMINATION
   *
   * *** THIS IS INFORMATION. IT IS NOT A WARNING AND IT GATES NOTHING. ***
   * A row whose denomination resolves to nothing is a correct, ordinary
   * import (design §4.1): the coin keeps the text the file gave and reads
   * `Other (8 Reales)`. `acceptedCount - linkedDenominations` is therefore
   * a perfectly healthy number, and anything in the UI that renders it as a
   * problem -- an amber box, a count of "errors", a disabled button -- is
   * wrong about the data model and should be removed rather than tuned.
   *
   * WHY SHOW IT AT ALL, THEN. Because it is the cheapest possible check on
   * the MAPPING, which is the one thing on that screen the user can get
   * wrong in a way nothing else detects. A `Grade` column mapped onto
   * Denomination produces rows that pass the 2-of-3 rule, import happily,
   * and are all subtly wrong; the only visible symptom at preview time is
   * that nothing links. 1,204 of 1,312 reads as "fine"; 0 of 1,312 reads as
   * "go and look at the mapping", and both readings cost one line of text.
   *
   * Counted over `accepted` only, because a rejected row is not going to be
   * created and a count including it would not match what is imported.
    */
  linkedDenominations: number;
}

/**
 * The signature of `CsvService.mapRowToCoin`.
 *
 * Passed in rather than imported so this module stays a pure function with
 * no Angular in it -- the established pattern here, because the frontend
 * specs run under Node with no DOM and nothing to bootstrap.
 */
export type RowMapper = (
  row: string[],
  headers: string[],
  mapping: Record<string, string>
) => CoinRecord;

/**
 * A short human label for a rejected row: whatever identifying fields were
 * read, or the row's first non-empty cell when nothing useful mapped at all
 * -- which usually means the MAPPING is wrong rather than the data, so
 * showing something recognisable from the row is what helps.
 */
function describeRow(coin: CoinRecord, row: string[]): string {
  const parts = [coin.year, coin.coinType, coin.denomination].filter(part => part && part.trim());
  if (parts.length > 0) return parts.join(' ');

  const firstCell = row.find(cell => cell.trim());
  return firstCell ? firstCell.trim() : '(empty row)';
}

/**
 * Work out exactly which rows would become coins, without creating any.
 *
 * Deliberately does NOT enrich with inferred metal / composition / weight.
 * That inference reads a finished record and fills only its blanks, it has
 * no bearing on the 2-of-3 verdict, and running it over every row of a
 * six-sheet workbook just to draw a preview would be wasted work. The
 * importer applies it to the accepted rows at the moment of import.
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

      /* THE SOLD FILTER RUNS BEFORE THE COMPLETENESS RULE, AND THAT ORDER
       * IS DELIBERATE. A row the user has asked not to import is not a row
       * he needs told about: listing "1881 Morgan — no Denomination" for a
       * coin he sold in 2013 and explicitly filtered out would be an
       * exception he can do nothing useful with. So an excluded sale is
       * counted and nothing else; only rows that were actually going to be
       * created are judged for detail. */
      if (excludeSold && isSoldRecord(mapped)) {
        excludedAsSold += 1;
        sheetExcludedAsSold += 1;
        return;
      }

      if (hasEnoughCoinDetail(mapped)) {
        accepted.push(mapped);
        sheetAccepted += 1;
        /* Counted, never acted on. `mapRow` has already asked the one
         * resolver; this only reads the answer, so the preview cannot
         * disagree with what the import writes. A null id is the ordinary
         * state of a coin, not a fault -- see the long note on
         * `ImportPlan.linkedDenominations`. */
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
