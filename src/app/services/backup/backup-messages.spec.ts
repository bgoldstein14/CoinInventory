/**
 * backup-messages.spec.ts — the wording IS the safety feature.
 *
 * Everything the server does to protect a collection only protects
 * anybody if the user understands it at the moment they are about to
 * press a button. "Verdict: newer-schema" protects nobody. So these
 * assertions are about meaning, not formatting — does the sentence
 * actually say the thing the user has to know?
 *
 * Pure functions, no DOM, no Angular: the suite runs under Node with no
 * jsdom, which is exactly why this logic is not in the template.
 */

import { describe, expect, it } from 'vitest';

import {
  BackupInspection,
  BackupJobStatus,
  RestoreResult,
  canCancelBackup,
  describeBackupBlock,
  describeBackupContents,
  describeBackupFile,
  describeBackupStatus,
  describeCoinCount,
  describeFolderListing,
  describeRestoreBlock,
  describePhotoWarning,
  describeRestoreConsequence,
  describeRestoreOutcome,
  formatBytes,
  formatTakenAt
} from './backup-messages';

function job(overrides: Partial<BackupJobStatus> = {}): BackupJobStatus {
  return {
    id: 'job-1',
    state: 'running',
    destination: 'C:\\Users\\You\\Desktop\\backup.db',
    percent: 40,
    totalPages: 100,
    copiedPages: 40,
    startedAt: '2026-11-14T10:00:00.000Z',
    finishedAt: null,
    result: null,
    error: null,
    ...overrides
  };
}

function inspection(overrides: Partial<BackupInspection> = {}): BackupInspection {
  return {
    path: 'C:\\Users\\You\\Desktop\\backup.db',
    fileSizeBytes: 612_300_000,
    decision: { verdict: 'ok', acceptable: true, message: 'fine', missingTables: [] },
    schemaVersion: 1,
    coinCount: 412,
    imageCount: 20,
    storedImageCount: 20,
    referencedOnlyImageCount: 0,
    referencedFolders: [],
    provenance: { takenAt: '2026-11-14T09:15:00.000Z', recordedCoinCount: 412 },
    ...overrides
  };
}

describe('formatBytes', () => {
  it('uses the decimal units Windows Explorer shows', () => {
    // So a user comparing this with their folder does not wonder why the
    // two disagree.
    expect(formatBytes(612_300_000)).toBe('612.3 MB');
    expect(formatBytes(4_000_000_000)).toBe('4.0 GB');
    expect(formatBytes(1500)).toBe('1.5 kB');
  });

  it('spells out small sizes rather than saying 0.0 kB', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(0)).toBe('0 bytes');
  });

  it('says "unknown size" rather than NaN for a missing figure', () => {
    expect(formatBytes(null)).toBe('unknown size');
    expect(formatBytes(undefined)).toBe('unknown size');
    expect(formatBytes(Number.NaN)).toBe('unknown size');
  });
});

describe('formatTakenAt', () => {
  it('reads as a date a person recognises', () => {
    const local = new Date(2026, 10, 14, 15, 4);
    expect(formatTakenAt(local.toISOString())).toBe('14 Nov 2026, 15:04');
  });

  it('shows the LOCAL time, because the user is comparing it to their day', () => {
    // The stamp in the file is UTC so a machine can read it. This is the
    // human reading it, answering "is this the one I took this morning?"
    const local = new Date(2026, 10, 14, 8, 30);
    expect(formatTakenAt(local.toISOString())).toContain('08:30');
  });

  it('says "unknown" for a backup taken before stamping existed', () => {
    expect(formatTakenAt(null)).toBe('unknown');
    expect(formatTakenAt('')).toBe('unknown');
    expect(formatTakenAt('last Tuesday')).toBe('unknown');
  });
});

describe('describeCoinCount', () => {
  it('gets the singular right', () => {
    expect(describeCoinCount(1)).toBe('1 coin');
    expect(describeCoinCount(0)).toBe('0 coins');
    expect(describeCoinCount(412)).toBe('412 coins');
  });

  it('admits when it does not know', () => {
    expect(describeCoinCount(null)).toBe('an unknown number of coins');
  });
});

describe('describeBackupStatus', () => {
  it('shows a percentage while it runs', () => {
    expect(describeBackupStatus(job({ percent: 37 }))).toContain('37%');
  });

  it('does not show 0% before the page count is known', () => {
    // 0/0 is not "nothing has happened yet", it is "we have not asked".
    expect(describeBackupStatus(job({ totalPages: 0, percent: 0 }))).toMatch(/starting/i);
  });

  it('names the size and the coin count when it finishes', () => {
    const done = job({
      state: 'done',
      percent: 100,
      result: {
        path: 'C:\\Users\\You\\Desktop\\backup.db',
        fileSizeBytes: 612_300_000,
        pagesCopied: 10,
        coinCount: 412,
        takenAt: '2026-11-14T09:15:00.000Z',
        schemaVersion: 1
      }
    });
    expect(describeBackupStatus(done)).toContain('412 coins');
    expect(describeBackupStatus(done)).toContain('612.3 MB');
  });

  it('says explicitly that a cancelled backup left nothing behind', () => {
    // An unfinished .db in the user's backup folder WOULD be dangerous —
    // they would try to restore from it one day — so the absence of one
    // is worth stating rather than leaving them to wonder.
    expect(describeBackupStatus(job({ state: 'cancelled' }))).toMatch(
      /no file was left behind/i
    );
  });

  it('shows the server\'s own sentence when it fails', () => {
    const failed = job({ state: 'failed', error: 'There is no folder called D:\\Backpus' });
    expect(describeBackupStatus(failed)).toBe('There is no folder called D:\\Backpus');
  });

  it('is empty before anything has been started', () => {
    expect(describeBackupStatus(null)).toBe('');
  });
});

describe('canCancelBackup', () => {
  it('offers Cancel only while it is running', () => {
    expect(canCancelBackup(job({ state: 'running' }))).toBe(true);
    expect(canCancelBackup(job({ state: 'done' }))).toBe(false);
    expect(canCancelBackup(job({ state: 'cancelled' }))).toBe(false);
    expect(canCancelBackup(null)).toBe(false);
  });
});

describe('describeBackupContents — telling one backup from another', () => {
  it('leads with the coin count and the date, which is the actual question', () => {
    const lines = describeBackupContents(inspection());
    expect(lines[0]).toContain('412 coins');
    expect(lines[1]).toContain('14 Nov 2026');
  });

  it('is honest about an unstamped backup rather than inventing a date', () => {
    const lines = describeBackupContents(
      inspection({ provenance: { takenAt: null, recordedCoinCount: null } })
    );
    expect(lines.some((line) => line.includes('unknown'))).toBe(true);
  });

  it('says nothing at all about a file that was refused', () => {
    // "0 coins" under "that is not a Coin Inventory backup" reads as
    // though we looked inside and found it empty.
    const refused = inspection({
      decision: {
        verdict: 'not-sqlite',
        acceptable: false,
        message: 'That file is not a Coin Inventory backup.',
        missingTables: []
      }
    });
    expect(describeBackupContents(refused)).toEqual([]);
    expect(describeBackupContents(null)).toEqual([]);
  });
});

describe('describeRestoreConsequence', () => {
  it('states BOTH facts a user will not infer', () => {
    const text = describeRestoreConsequence(inspection())!;
    // 1. the current collection is replaced
    expect(text).toMatch(/replace the collection you are using now/i);
    // 2. ...and it is kept
    expect(text).toMatch(/not deleted/i);
    expect(text).toContain('412 coins');
  });

  it('says nothing for a refused file', () => {
    expect(
      describeRestoreConsequence(
        inspection({
          decision: { verdict: 'newer-schema', acceptable: false, message: 'no', missingTables: [] }
        })
      )
    ).toBeNull();
  });
});

/* *** CONSEQUENCE OF PORTABILITY #1. *** */
describe('describePhotoWarning', () => {
  it('says nothing when every photograph is inside the file', () => {
    // The common case. An empty yellow panel is worse than no panel.
    expect(describePhotoWarning(0, [])).toBeNull();
    expect(describePhotoWarning(null, null)).toBeNull();
  });

  it('names the missing folders and says the coins are fine', () => {
    const text = describePhotoWarning(37, ['Z:\\OtherPC\\Coins'])!;

    expect(text).toContain('37 photographs');
    expect(text).toContain('Z:\\OtherPC\\Coins');
    expect(text).toMatch(/not on this computer/i);
    // THE PART THAT STOPS THE PANIC: it is the link to the picture files
    // that does not travel, not the collection.
    expect(text).toMatch(/restore completely/i);
    expect(text).toMatch(/every detail, price and note/i);
  });

  it('gets the grammar right for one photograph and one folder', () => {
    const text = describePhotoWarning(1, ['D:\\Photos'])!;
    expect(text).toContain('1 photograph');
    expect(text).toContain('folder they point to');
    expect(text).toMatch(/\bis not on this computer/);
  });

  it('still warns when the folders ARE here, because a drive letter moves', () => {
    const text = describePhotoWarning(5, [])!;
    expect(text).toMatch(/on this computer at the moment/i);
    expect(text).toMatch(/moved, renamed or deleted/i);
  });

  it('does not promise a repair tool that does not exist', () => {
    // The photo-relocation tool (design §4.4) is not built. Promising one
    // would be worse than the silence.
    const text = describePhotoWarning(37, ['Z:\\OtherPC\\Coins'])!;
    expect(text).not.toMatch(/relocat|repair|re-?link|fix the/i);
  });
});

describe('describeRestoreOutcome — the undo button', () => {
  const outcome: RestoreResult = {
    restoredFrom: 'C:\\Users\\You\\Desktop\\backup.db',
    databasePath: 'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.db',
    previousCollectionMovedTo:
      'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.replaced-2026-11-14-162030.db',
    coinCount: 3,
    referencedOnlyImageCount: 0,
    missingPhotoFolders: [],
    takenAt: '2026-11-14T09:15:00.000Z',
    serverRestartRequired: false
  };

  it('*** NAMES WHERE THE OLD COLLECTION WENT, IN FULL ***', () => {
    // This is the entire recovery procedure for the most likely mistake
    // in the feature. It has to be on screen, not in a log.
    const lines = describeRestoreOutcome(outcome);
    const text = lines.join(' ');

    expect(text).toContain(outcome.previousCollectionMovedTo!);
    expect(text).toMatch(/not deleted/i);
    // ...and what to DO with it.
    expect(text).toMatch(/copy that file back/i);
    expect(text).toContain(outcome.databasePath);
  });

  it('reports what was restored and from where', () => {
    const text = describeRestoreOutcome(outcome).join(' ');
    expect(text).toContain('3 coins');
    expect(text).toContain('C:\\Users\\You\\Desktop\\backup.db');
  });

  it('does not invent an aside file when there was no collection to keep', () => {
    const lines = describeRestoreOutcome({ ...outcome, previousCollectionMovedTo: null });
    expect(lines.join(' ')).toMatch(/no existing collection to keep/i);
    expect(lines.join(' ')).not.toMatch(/copy that file back/i);
  });
});

/* ===================== Choosing instead of typing =====================
 *
 * The three sentences added after the owner tested the feature and found
 * the restore panel unusable. The one that matters most is the last:
 * he believed the grey example path was a value and had nothing on
 * screen to tell him why the buttons were dead.
 */

describe('describeBackupFile', () => {
  it('gives the two things that tell two backups apart', () => {
    const text = describeBackupFile({
      name: 'coin-inventory-backup-2026-11-14-1432.db',
      path: 'C:\Users\You\Desktop\coin-inventory-backup-2026-11-14-1432.db',
      sizeBytes: 612_300_000,
      modifiedAt: '2026-11-14T16:20:00.000Z'
    });

    expect(text).toContain('612.3 MB');
    expect(text).toContain('14 Nov 2026');
  });
});

describe('describeFolderListing', () => {
  const base = { directory: 'C:\Users\You\Desktop', truncated: false };

  it('says plainly when a folder holds no backups', () => {
    // *** A NORMAL OUTCOME. *** It is what a guessed folder, a fresh
    // install, and a folder picker that narrowed to the wrong parent all
    // produce. An uncaptioned empty space reads as "your backups are
    // gone", so the sentence has to name the folder and offer the two
    // explanations that are actually likely.
    const text = describeFolderListing({ ...base, files: [] })!;

    expect(text).toContain('C:\Users\You\Desktop');
    expect(text).toMatch(/no backup \(\.db\) files/i);
    expect(text).toMatch(/none have been made yet/i);
  });

  it('counts what it found and says the newest is first', () => {
    const text = describeFolderListing({
      ...base,
      files: [
        { name: 'a.db', path: 'C:\a.db', sizeBytes: 1, modifiedAt: '2026-11-14T16:20:00.000Z' },
        { name: 'b.db', path: 'C:\b.db', sizeBytes: 1, modifiedAt: '2026-11-13T16:20:00.000Z' }
      ]
    })!;

    expect(text).toContain('2 backup files');
    expect(text).toMatch(/newest first/i);
  });

  it('admits when the list was cut short', () => {
    const text = describeFolderListing({
      ...base,
      truncated: true,
      files: [{ name: 'a.db', path: 'C:\a.db', sizeBytes: 1, modifiedAt: '2026-11-14T16:20:00.000Z' }]
    })!;

    expect(text).toMatch(/only the first 200/i);
  });

  it('says nothing at all before the folder has been looked in', () => {
    expect(describeFolderListing(null)).toBeNull();
  });
});

describe('describeBackupBlock', () => {
  it('explains an empty folder box instead of leaving a dead button', () => {
    const reason = describeBackupBlock('', false)!;
    expect(reason).toMatch(/folder box is empty/i);
    expect(reason).toMatch(/grey text in the box is an example, not a value/i);
  });

  it('is silent once there is a folder', () => {
    expect(describeBackupBlock('C:\Users\You\Desktop', false)).toBeNull();
    expect(describeBackupBlock('   ', false)).not.toBeNull();
  });

  it('says nothing while a backup is running', () => {
    // There is a progress bar and a Cancel button directly above, which
    // explain the disabled button better than a sentence would.
    expect(describeBackupBlock('', true)).toBeNull();
  });
});

describe('describeRestoreBlock', () => {
  it('*** contradicts the belief that the box is filled in ***', () => {
    // THE BUG, in the owner's words: "the watermarked restore field
    // looked like it was filled in text and it could leave the user
    // bewildered why the buttons weren't enabled." Styling the empty
    // state fixes half of it; this is the other half, and it has to
    // name the grey text, because the grey text is what he believed.
    const reason = describeRestoreBlock('', false, false)!;

    expect(reason).toMatch(/no backup file is chosen yet/i);
    expect(reason).toMatch(/grey text in the box is an example, not a value/i);
    // And it says what to do about it, both ways.
    expect(reason).toMatch(/pick one from the list/i);
    expect(reason).toMatch(/paste the full path/i);
  });

  it('treats a box of spaces as empty, like the button does', () => {
    expect(describeRestoreBlock('   ', false, false)).not.toBeNull();
  });

  it('is silent once a file is chosen', () => {
    expect(describeRestoreBlock('C:\Users\You\Desktop\backup.db', false, false)).toBeNull();
  });

  it('says nothing while the file is being checked or restored', () => {
    // The button already says "Checking…" / "Restoring…".
    expect(describeRestoreBlock('', true, false)).toBeNull();
    expect(describeRestoreBlock('', false, true)).toBeNull();
  });
});
