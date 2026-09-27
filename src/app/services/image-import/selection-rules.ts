/* ===========================================================================
 * selection-rules.ts
 * ---------------------------------------------------------------------------
 * The bulk tick-box rules, as pure functions.
 *
 * Every matched image arrives ticked (the user asked for that explicitly), and
 * a coin often has 8-10 files. Unticking one at a time across ~200 coins would
 * be miserable, so the review screen offers one-click rules. Keeping them here
 * as pure `rows -> rows` functions means:
 *
 *   - they can be unit tested without a component or a browser,
 *   - the component stays a thin "signal.update(rows => rule(rows))",
 *   - each rule's definition of "retake" / "label" lives in exactly one place.
 *
 * All rules return a NEW array of NEW row objects. Angular signals compare by
 * reference, so mutating rows in place would leave the UI stale.
 * =========================================================================== */

import { BatchImageRow, SelectionBulkAction } from '../../types/coin.model';

/**
 * A row can only be ticked if the matcher (or the user) actually attached it
 * to a coin. An unresolved 'review'/'none' row has nowhere to go, so it is
 * never ticked regardless of which rule ran.
 */
function isAttachable(row: BatchImageRow): boolean {
  return !!row.selectedCoinId && row.decision !== 'skipped';
}

/** Tick or untick everything that has a coin to go to. */
export function setAllSelected(rows: readonly BatchImageRow[], selected: boolean): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected: selected && isAttachable(row)
  }));
}

/**
 * "Keep only Obverse + Reverse."
 *
 * Ticks the two faces of the coin and unticks everything else - Label shots,
 * retakes, derivatives and anything whose side we could not read. This is the
 * single most useful control: it takes a 10-file coin down to the 2 photos the
 * gallery actually wants.
 *
 * Note it keeps ALL obverse/reverse files, including retakes of them. Pair it
 * with `deselectRetakes` to get down to exactly one shot per face; the review
 * screen exposes both buttons so the user can decide.
 */
export function keepOnlyObverseReverse(rows: readonly BatchImageRow[]): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected:
      isAttachable(row) && (row.photo.side === 'obverse' || row.photo.side === 'reverse')
  }));
}

/**
 * "Deselect retakes."
 *
 * Unticks second-and-later shots (a trailing "-2", "-3") and derivative
 * renderings ("- Small", "- Orig", "- Sharpened"), leaving the first/original
 * shot of each face ticked. Rows that are already unticked stay unticked - the
 * rule only ever removes, never adds.
 */
export function deselectRetakes(rows: readonly BatchImageRow[]): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected: row.selected && !row.photo.isRetake
  }));
}

/**
 * "Deselect Label shots."
 *
 * The slab label photo documents the grading holder, not the coin. Some users
 * want it for provenance, most do not, so it is its own button. Subtractive,
 * like deselectRetakes.
 */
export function deselectLabels(rows: readonly BatchImageRow[]): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected: row.selected && row.photo.side !== 'label'
  }));
}

/** Flip one row by filename, leaving every other row untouched. */
export function toggleRow(
  rows: readonly BatchImageRow[],
  fileName: string,
  selected?: boolean
): BatchImageRow[] {
  return rows.map(row => {
    if (row.fileName !== fileName) return row;
    const next = selected ?? !row.selected;
    // Guard rail: you cannot tick a row with no coin behind it.
    return { ...row, selected: next && isAttachable(row) };
  });
}

/**
 * Apply a named bulk action, optionally limited to one coin.
 *
 * `coinId` is how the per-coin buttons work: the rule is applied to that
 * coin's rows and every other row is passed through byte-for-byte.
 */
export function applyBulkAction(
  rows: readonly BatchImageRow[],
  action: SelectionBulkAction,
  coinId?: string
): BatchImageRow[] {
  // Split into "rows the action applies to" and "everything else", run the
  // rule on the first set, then stitch the original order back together.
  const inScope = coinId ? rows.filter(r => r.selectedCoinId === coinId) : [...rows];
  const updated = runAction(inScope, action);

  const byFileName = new Map(updated.map(row => [row.fileName, row]));
  return rows.map(row => byFileName.get(row.fileName) ?? row);
}

/** The action -> rule lookup, kept separate so applyBulkAction reads cleanly. */
function runAction(rows: readonly BatchImageRow[], action: SelectionBulkAction): BatchImageRow[] {
  switch (action) {
    case 'select-all': return setAllSelected(rows, true);
    case 'deselect-all': return setAllSelected(rows, false);
    case 'keep-obverse-reverse': return keepOnlyObverseReverse(rows);
    case 'deselect-retakes': return deselectRetakes(rows);
    case 'deselect-labels': return deselectLabels(rows);
  }
}
