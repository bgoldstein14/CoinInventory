 /*
 * import-progress.ts — "the import is working, here is how far it has got"
 *
 * THE TWO FAILURES THIS EXISTS TO PREVENT
 *
 * A progress bar is not enough on its own. A screen can have one and still
 * look frozen, for two independent reasons that both have to be addressed:
 *
 *   1. THE INDICATOR MUST COVER THE SLOW PARTS, AND START EARLY.
 *
 *        - picking a folder runs `filterImageFiles` over ~2,140 File handles;
 *        - `runAttach` reads, decodes and downscales the FIRST file off the
 *          share before it has anything to report. For a 46 MB JPEG over SMB
 *          that is several seconds of dead screen -- and, because `busy()`
 *          reads off `progress`, several seconds with the Save button still
 *          live, so an impatient second click starts the entire import again;
 *        - the longest wait of all is Angular building the review screen out
 *          of 2,140 finished rows, which happens AFTER the rows are handed
 *          over.
 *
 *   2. SETTING A SIGNAL DOES NOT DRAW ANYTHING. JavaScript is single
 *      threaded. A write to `progress` only becomes pixels when the current
 *      task ends and the browser gets a frame. Setting the matching progress
 *      and then running the first 200-filename chunk in the SAME task (~1.1 s
 *      against a 2,000-coin inventory) means the bar's first appearance is
 *      already a second late. An indicator with no yield in front of it is
 *      not an indicator, it is a comment.
 *
 * This file is the first half of the answer: a single vocabulary for "which
 * stage, how far, what do we call it", with a factory per stage so that
 * adding a stage without announcing it is awkward. The second half --
 * `await yieldToBrowser()` in front of every stage -- lives in
 * batch-import-session.ts and attach-runner.ts.
 *
 * WHY THIS IS A STANDALONE FILE OF PLAIN FUNCTIONS
 *
 * The same reason coin-editor-form/custom-option-mode.ts is: the unit suite
 * runs under Node with no jsdom, so a template cannot be rendered and a
 * spinner cannot be asserted on. Pulled out here, every rule that decides what
 * the user sees — the wording, the bar width, whether the buttons are
 * disabled — is an ordinary function with an ordinary test.
  */

import { BatchImportProgress } from '../../types/coin.model';

/** Thousands separators, so "2140 of 2140" reads as 2,140. */
const count = (n: number): string => n.toLocaleString('en-US');

/** Every field blank, for the factories to override. */
function base(phase: BatchImportProgress['phase'], total: number): BatchImportProgress {
  return { total, processed: 0, attached: 0, failed: 0, currentFile: '', phase };
}

 /*
 * THE FACTORIES — one per stage that can keep the main thread
  */

/**
 * Stage 0: the picker has handed over File handles and we are deciding which
 * of them are displayable images.
 *
 * `total` is the number of files SELECTED, not a number of finished units —
 * there is no honest per-item count here, which is why this phase is
 * indeterminate. It is carried anyway because "2,140 files selected" is the
 * single most reassuring thing we can say at that moment: it tells the user
 * the folder was read and that the wait is proportional to what they picked.
 */
export const scanningProgress = (fileCount: number): BatchImportProgress =>
  base('scanning', fileCount);

/** Stage 1: filenames being matched to coins, in chunks, with a real count. */
export function matchingProgress(processed: number, total: number): BatchImportProgress {
  return { ...base('matching', total), processed };
}

/**
 * Stage 2: the rows are finished and Angular is building the review screen.
 *
 * Indeterminate for the same reason `scanning` is, and present for a reason
 * that is easy to miss: this stage is not our code. The wait is Angular
 * creating DOM, so nothing inside the loop can report on it. All we can do is
 * put the indicator up, yield so it paints, hand over the rows, and take the
 * indicator down on the far side.
 */
export const buildingProgress = (rowCount: number): BatchImportProgress =>
  base('building', rowCount);

/**
 * Stage 3, at zero files done — the state the screen must be in the instant
 * Save is clicked.
 *
 * This is the one that fixes the double-import. `busy()` is derived from
 * `progress`, so until something sets it the Save button stays enabled, and
 * the window in which it stayed enabled was the slowest single operation in
 * the feature: the first file's read + decode + downscale.
 */
export const startingAttachProgress = (total: number): BatchImportProgress =>
  base('attaching', total);

 /*
 * WHAT THE SCREEN DOES WITH IT
  */

/** The four phases during which the buttons must be dead. */
const WORKING_PHASES: ReadonlySet<BatchImportProgress['phase']> = new Set([
  'scanning',
  'matching',
  'building',
  'attaching'
]);

/**
 * "Something long is running." Drives every `[disabled]` on the screen, so a
 * stage that forgets to produce a progress object is also a stage during
 * which the user can fire the import again.
 *
 * `done` is deliberately NOT busy: the runner emits it after the last write,
 * and the only thing left to do is show the summary.
 */
export const isBusy = (progress: BatchImportProgress | null | undefined): boolean =>
  !!progress && WORKING_PHASES.has(progress.phase);

/**
 * True for the stages with no countable unit of work.
 *
 * A determinate bar pinned at 0% for four seconds is read as "stuck" — it is
 * the frozen screen again, just with a rectangle on it. The template animates
 * the track instead for these.
 */
export const isIndeterminate = (progress: BatchImportProgress | null | undefined): boolean =>
  progress?.phase === 'scanning' || progress?.phase === 'building';

/**
 * How full the bar is, 0-100.
 *
 * Clamped at both ends rather than trusted: a bar that renders at 102% breaks
 * out of its track, and `processed / 0` is NaN, which CSS silently drops and
 * which would leave the previous width on screen forever.
 */
export function progressPercent(progress: BatchImportProgress | null | undefined): number {
  if (!progress || progress.total <= 0 || isIndeterminate(progress)) return 0;
  const pct = (progress.processed / progress.total) * 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * The line of text above the bar.
 *
 * A real count rather than a spinner, and the count is ONE-BASED for the
 * attaching stage. `processed` counts files FINISHED, so while the first file
 * is being read `processed` is 0 -- and "Processing 0 of 317" is precisely
 * the message that reads as nothing happening. The file being worked on right
 * now is `processed + 1`, capped at the total so the final tick cannot claim
 * to be on file 318 of 317.
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
 * What the Save button itself should say.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BUTTON NEEDS ITS OWN LABEL WHEN THERE IS ALREADY A PROGRESS BAR
 * ---------------------------------------------------------------------------
 * Because the bar is at the top of the dialog and the button is at the bottom
 * of it, and in between sits a review list that routinely runs to hundreds of
 * rows inside a scrolling container. By the time the user reaches Save they
 * have scrolled several screens past the place the feedback appears, and an
 * indicator that cannot be seen from where the user is standing is not an
 * indicator.
 *
 * A label on the button cannot have that problem: it is attached to the
 * control that was pressed, so it is on screen by construction. The top bar
 * is pinned as well, but this is the half that does not depend on scroll
 * position at all, and it is the one to keep if the two ever have to be
 * reconciled.
 *
 * @param progress    the live progress, or null when idle
 * @param attachCount how many photos pressing Save would write
 */
export function saveButtonLabel(
  progress: BatchImportProgress | null | undefined,
  attachCount: number
): string {
  if (progress?.phase === 'attaching') {
    // One-based, and clamped: `processed` counts files FINISHED, so the last
    // file would otherwise read "Saving 318 of 317". Same convention as
    // progressLabel() above — the two must not disagree on screen.
    const current = Math.min(progress.processed + 1, progress.total);
    return `Saving ${count(current)} of ${count(progress.total)}…`;
  }

  // Scanning / matching / building have the top indicator to themselves, but
  // the button is disabled throughout them, so it must not go on offering an
  // action that cannot be taken.
  if (isBusy(progress)) return 'Working…';

  return `Save ${count(attachCount)} photo${attachCount === 1 ? '' : 's'}`;
}

/**
 * The secondary line: which file is being read right now.
 *
 * Only the attaching stage has one, and it is blanked on `done` so the last
 * filename does not sit there looking like the run is stuck on it.
 */
export const progressDetail = (progress: BatchImportProgress | null | undefined): string =>
  progress?.phase === 'attaching' ? progress.currentFile : '';
