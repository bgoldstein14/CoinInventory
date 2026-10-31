/**
 * Tests for import-progress.ts — the busy/progress vocabulary of the batch
 * image import.
 *
 * These are plain function tests on purpose. The suite runs under Node with no
 * jsdom, so there is no way to assert "the spinner appeared"; what CAN be
 * asserted, and what actually matters, is that every long stage produces a
 * progress object, that `isBusy` is true for all of them, and that the label
 * and the bar width describe that object honestly.
 */
import { describe, expect, it } from 'vitest';
import { BatchImportProgress } from '../../types/coin.model';
import {
  buildingProgress,
  isBusy,
  isIndeterminate,
  matchingProgress,
  progressDetail,
  progressLabel,
  progressPercent,
  scanningProgress,
  startingAttachProgress
} from './import-progress';

/** An attaching-phase progress object, mid-run. */
function attaching(overrides: Partial<BatchImportProgress> = {}): BatchImportProgress {
  return {
    total: 317,
    processed: 41,
    attached: 41,
    failed: 0,
    currentFile: '1881-S Morgan Dollar - Obverse.jpg',
    phase: 'attaching',
    ...overrides
  };
}

/* =========================================================================
 * THE FACTORIES — one per long stage, so no stage can go unannounced
 * ======================================================================= */
describe('import-progress — the stage factories', () => {
  it('announces the folder scan before a single file has been classified', () => {
    const progress = scanningProgress(2140);

    expect(progress.phase).toBe('scanning');
    expect(progress.total).toBe(2140);
    expect(progress.processed).toBe(0);
    expect(isBusy(progress)).toBe(true);
  });

  it('announces matching with a real done-of-total count', () => {
    const progress = matchingProgress(400, 2140);

    expect(progress.phase).toBe('matching');
    expect(progress.processed).toBe(400);
    expect(progress.total).toBe(2140);
    expect(isBusy(progress)).toBe(true);
  });

  it('announces the review-screen build, which happens after matching finishes', () => {
    const progress = buildingProgress(1780);

    expect(progress.phase).toBe('building');
    expect(progress.total).toBe(1780);
    expect(isBusy(progress)).toBe(true);
  });

  /**
   * THE BUG THIS TEST EXISTS FOR.
   *
   * The Save button used to stay enabled for the whole of the first file,
   * because nothing set `progress` until the first file had been read and
   * downscaled — several seconds for a 46 MB JPEG on a network share. A second
   * click in that window started the entire import again.
   */
  it('announces attaching at zero files done, so busy is true before the first read', () => {
    const progress = startingAttachProgress(317);

    expect(progress.phase).toBe('attaching');
    expect(progress.processed).toBe(0);
    expect(progress.attached).toBe(0);
    expect(progress.failed).toBe(0);
    expect(progress.total).toBe(317);
    expect(isBusy(progress)).toBe(true);
  });
});

/* =========================================================================
 * isBusy — what disables the buttons
 * ======================================================================= */
describe('import-progress — isBusy', () => {
  it('is false when nothing is running', () => {
    expect(isBusy(null)).toBe(false);
    expect(isBusy(undefined)).toBe(false);
    expect(isBusy(attaching({ phase: 'idle' }))).toBe(false);
  });

  it('is false once the run has reported done', () => {
    expect(isBusy(attaching({ phase: 'done' }))).toBe(false);
  });

  it('is true for every one of the four working phases', () => {
    for (const phase of ['scanning', 'matching', 'building', 'attaching'] as const) {
      expect(isBusy(attaching({ phase })), phase).toBe(true);
    }
  });
});

/* =========================================================================
 * THE BAR
 * ======================================================================= */
describe('import-progress — progressPercent', () => {
  it('is the share of files finished', () => {
    expect(progressPercent(attaching({ processed: 50, total: 200 }))).toBe(25);
  });

  it('is zero rather than NaN when there is nothing to do', () => {
    expect(progressPercent(attaching({ processed: 0, total: 0 }))).toBe(0);
    expect(progressPercent(null)).toBe(0);
  });

  it('never exceeds 100 even if a caller over-counts', () => {
    expect(progressPercent(attaching({ processed: 999, total: 200 }))).toBe(100);
  });

  it('never goes negative', () => {
    expect(progressPercent(attaching({ processed: -5, total: 200 }))).toBe(0);
  });

  /**
   * Scanning and building have no countable unit of work, so a bar that sat at
   * 0% would read as "stuck". They are flagged indeterminate instead, and the
   * template animates the track rather than filling it.
   */
  it('reports the countless stages as indeterminate', () => {
    expect(isIndeterminate(scanningProgress(2140))).toBe(true);
    expect(isIndeterminate(buildingProgress(1780))).toBe(true);
    expect(isIndeterminate(matchingProgress(0, 2140))).toBe(false);
    expect(isIndeterminate(startingAttachProgress(317))).toBe(false);
    expect(isIndeterminate(null)).toBe(false);
  });
});

/* =========================================================================
 * THE WORDS
 * ======================================================================= */
describe('import-progress — progressLabel', () => {
  it('says nothing when nothing is running', () => {
    expect(progressLabel(null)).toBe('');
    expect(progressLabel(attaching({ phase: 'idle' }))).toBe('');
  });

  it('names the folder scan and how many files came back', () => {
    expect(progressLabel(scanningProgress(2140))).toBe('Reading the folder… 2,140 files selected');
  });

  it('counts the matching stage', () => {
    expect(progressLabel(matchingProgress(400, 2140))).toBe('Matching file names… 400 of 2,140');
  });

  it('names the review-screen build', () => {
    expect(progressLabel(buildingProgress(1780))).toBe('Building the review list… 1,780 photos');
  });

  /**
   * One-based, because "Processing 0 of 317" is what a user reads as frozen.
   * `processed` counts files FINISHED, so the file being worked on right now
   * is `processed + 1`.
   */
  it('counts the file being worked on, not the ones already finished', () => {
    expect(progressLabel(startingAttachProgress(317))).toBe('Processing 1 of 317…');
    expect(progressLabel(attaching({ processed: 41, total: 317 }))).toBe('Processing 42 of 317…');
  });

  it('does not claim to be processing a file past the end of the run', () => {
    expect(progressLabel(attaching({ processed: 317, total: 317 }))).toBe('Processing 317 of 317…');
  });

  it('falls back to a plain message when there is nothing to count', () => {
    expect(progressLabel(attaching({ processed: 0, total: 0 }))).toBe('Saving…');
  });

  it('says so when the run has finished', () => {
    expect(progressLabel(attaching({ phase: 'done' }))).toBe('Finishing up…');
  });
});

describe('import-progress — progressDetail', () => {
  it('is the file being read, which only the attaching stage has', () => {
    expect(progressDetail(attaching())).toBe('1881-S Morgan Dollar - Obverse.jpg');
    expect(progressDetail(matchingProgress(1, 2))).toBe('');
    expect(progressDetail(null)).toBe('');
  });

  it('is blank once the run is done, so the last filename does not linger', () => {
    expect(progressDetail(attaching({ phase: 'done' }))).toBe('');
  });
});
