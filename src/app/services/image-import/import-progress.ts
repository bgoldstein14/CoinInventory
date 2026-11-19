 /*
 * Progress state for the batch import: one factory per slow stage, plus the
 * label, bar width and busy rules the screen uses.
 *
 * Every stage that can block the main thread (filtering thousands of files,
 * matching, Angular building the review list, reading the first file) must set
 * progress first and then `await yieldToBrowser()` (in batch-import-session.ts
 * and attach-runner.ts); a signal write alone doesn't paint until the task ends.
 *
 * Plain functions so the rules are testable under Node without a DOM.
  */

import { BatchImportProgress } from '../../types/coin.model';

/** Thousands separators, so "2140 of 2140" reads as 2,140. */
const count = (n: number): string => n.toLocaleString('en-US');

/** Every field blank, for the factories to override. */
function base(phase: BatchImportProgress['phase'], total: number): BatchImportProgress {
  return { total, processed: 0, attached: 0, failed: 0, currentFile: '', phase };
}

/* --- One factory per stage that can block the main thread --- */

/**
 * Stage 0: deciding which picked files are displayable images. Indeterminate;
 * `total` is the number of files selected.
 */
export const scanningProgress = (fileCount: number): BatchImportProgress =>
  base('scanning', fileCount);

/** Stage 1: filenames being matched to coins, in chunks, with a real count. */
export function matchingProgress(processed: number, total: number): BatchImportProgress {
  return { ...base('matching', total), processed };
}

/**
 * Stage 2: rows are finished and Angular is building the review screen.
 * Indeterminate, since the wait is Angular's DOM work, not a loop we control.
 */
export const buildingProgress = (rowCount: number): BatchImportProgress =>
  base('building', rowCount);

/**
 * Stage 3 at zero files done: set the instant Save is clicked so `busy()`
 * disables the button before the first (slow) file is read.
 */
export const startingAttachProgress = (total: number): BatchImportProgress =>
  base('attaching', total);

/** The four phases during which the buttons must be dead. */
const WORKING_PHASES: ReadonlySet<BatchImportProgress['phase']> = new Set([
  'scanning',
  'matching',
  'building',
  'attaching'
]);

/**
 * "Something long is running." Drives every `[disabled]` on the screen. `done`
 * is not busy: only the summary remains.
 */
export const isBusy = (progress: BatchImportProgress | null | undefined): boolean =>
  !!progress && WORKING_PHASES.has(progress.phase);

/**
 * True for stages with no countable unit of work; the template animates the
 * track instead of showing a bar stuck at 0%.
 */
export const isIndeterminate = (progress: BatchImportProgress | null | undefined): boolean =>
  progress?.phase === 'scanning' || progress?.phase === 'building';

/**
 * How full the bar is, 0-100. Clamped, and 0 when total is 0 (a NaN width
 * would be ignored by CSS and leave the old width on screen).
 */
export function progressPercent(progress: BatchImportProgress | null | undefined): number {
  if (!progress || progress.total <= 0 || isIndeterminate(progress)) return 0;
  const pct = (progress.processed / progress.total) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * The line of text above the bar. During attaching the count is one-based
 * (the file in progress, capped at the total), so the first file doesn't read
 * "Processing 0 of 317".
 */
export function progressLabel(progress: BatchImportProgress | null | undefined): string {
  if (!progress) return '';

  switch (progress.phase) {
    case 'scanning':
      return `Reading the folder… ${count(progress.total)} files selected`;

    case 'matching':
      return `Matching file names… ${count(progress.processed)} of ${count(progress.total)}`;

    case 'building':
      return `Building the review list… ${count(progress.total)} photos`;

    case 'attaching': {
      if (progress.total <= 0) return 'Saving…';
      const current = Math.min(progress.processed + 1, progress.total);
      return `Processing ${count(current)} of ${count(progress.total)}…`;
    }

    case 'done':
      return 'Finishing up…';

    default:
      return '';
  }
}

/**
 * The Save button's own text. It needs its own indicator because the progress
 * bar may be scrolled out of view above a long review list.
 *
 * @param progress    the live progress, or null when idle
 * @param attachCount how many photos pressing Save would write
 */
export function saveButtonLabel(
  progress: BatchImportProgress | null | undefined,
  attachCount: number
): string {
  if (progress?.phase === 'attaching') {
    // One-based and clamped, same as progressLabel().
    const current = Math.min(progress.processed + 1, progress.total);
    return `Saving ${count(current)} of ${count(progress.total)}…`;
  }

  // Disabled during the other busy stages, so don't offer the action.
  if (isBusy(progress)) return 'Working…';

  return `Save ${count(attachCount)} photo${attachCount === 1 ? '' : 's'}`;
}

/** The secondary line: the file being read, during attaching only. */
export const progressDetail = (progress: BatchImportProgress | null | undefined): string =>
  progress?.phase === 'attaching' ? progress.currentFile : '';
