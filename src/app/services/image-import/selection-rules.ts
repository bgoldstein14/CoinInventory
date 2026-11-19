 /*
 * selection-rules.ts
 *
 * The review screen's bulk tick-box rules, as pure `rows -> rows` functions.
 * Every matched image starts ticked and a coin often has 8-10 files.
 *
 * All rules return a new array of new row objects; signals compare by
 * reference, so mutating in place would leave the UI stale.
  */

import { BatchImageRow, SelectionBulkAction } from '../../types/coin.model';

/**
 * A row can only be ticked if it has a coin assigned and isn't skipped.
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
 * "Keep only Obverse + Reverse." Ticks obverse/reverse files (including their
 * retakes) and unticks labels and unknown sides. Combine with
 * `deselectRetakes` for one shot per face.
 */
export function keepOnlyObverseReverse(rows: readonly BatchImageRow[]): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected:
      isAttachable(row) && (row.photo.side === 'obverse' || row.photo.side === 'reverse')
  }));
}

/**
 * "Deselect retakes." Unticks take 2+ ("-2") and derivative renderings
 * ("- Small", "- Orig"). Subtractive only.
 */
export function deselectRetakes(rows: readonly BatchImageRow[]): BatchImageRow[] {
  return rows.map(row => ({
    ...row,
    selected: row.selected && !row.photo.isRetake
  }));
}

/**
 * "Deselect Label shots." The slab label photo shows the grading holder, not
 * the coin. Subtractive only.
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
    // A row with no coin can't be ticked.
    return { ...row, selected: next && isAttachable(row) };
  });
}

/**
 * Apply a named bulk action, optionally limited to one coin's rows (the
 * per-coin buttons); other rows pass through unchanged.
 */
export function applyBulkAction(
  rows: readonly BatchImageRow[],
  action: SelectionBulkAction,
  coinId?: string
): BatchImageRow[] {
  // Run the rule on the in-scope rows, then restore the original order.
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
