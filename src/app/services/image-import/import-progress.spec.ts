/**
 * Tests for import-progress.ts: every long stage produces a progress object,
 * `isBusy` is true for each, and the labels and bar width describe it.
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
  saveButtonLabel,
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

  // Busy before the first read, so Save can't be clicked twice.
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

  // Scanning and building have no countable work, so the bar is animated.
  it('reports the countless stages as indeterminate', () => {
    expect(isIndeterminate(scanningProgress(2140))).toBe(true);
    expect(isIndeterminate(buildingProgress(1780))).toBe(true);
    expect(isIndeterminate(matchingProgress(0, 2140))).toBe(false);
    expect(isIndeterminate(startingAttachProgress(317))).toBe(false);
    expect(isIndeterminate(null)).toBe(false);
  });
});

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

  // One-based: `processed` counts finished files, so the current one is +1.
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

 /*
 * The Save button shows progress itself, since it sits below a long
 * scrolling review list and the top indicator may be out of view.
  */
describe('import-progress — saveButtonLabel', () => {
  it('counts the photos to be saved when idle', () => {
    expect(saveButtonLabel(null, 317)).toBe('Save 317 photos');
  });

  it('uses the singular for one photo', () => {
    expect(saveButtonLabel(null, 1)).toBe('Save 1 photo');
  });

  it('groups thousands, so 1,284 does not read as 1284', () => {
    expect(saveButtonLabel(null, 1284)).toBe('Save 1,284 photos');
  });

  it('reports live progress while attaching', () => {
    expect(saveButtonLabel(attaching({ processed: 41, total: 317 }), 317))
      .toBe('Saving 42 of 317…');
  });

  it('never counts past the total on the final file', () => {
    // One-based label; must not read "Saving 318 of 317".
    expect(saveButtonLabel(attaching({ processed: 317, total: 317 }), 317))
      .toBe('Saving 317 of 317…');
  });

  // The button is disabled during earlier stages, so it says "Working…".
  it('says it is working during the stages before attaching', () => {
    expect(saveButtonLabel(matchingProgress(1, 2), 317)).toBe('Working…');
    expect(saveButtonLabel(scanningProgress(50), 317)).toBe('Working…');
    expect(saveButtonLabel(buildingProgress(50), 317)).toBe('Working…');
  });

  it('returns to the idle label once the run is done', () => {
    expect(saveButtonLabel(attaching({ phase: 'done' }), 317)).toBe('Save 317 photos');
  });
});
