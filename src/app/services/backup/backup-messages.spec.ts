/** Tests that the backup/restore wording tells the user what they need to know. */

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
    // The file stamp is UTC; the display is local time.
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
    // 0/0 means the server hasn't reported progress yet.
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
    // Say explicitly that no partial .db was left behind.
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
    // No "0 coins" under a refusal; it would read as an empty backup.
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
    // 2. ...and kept
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

describe('describePhotoWarning', () => {
  it('says nothing when every photograph is inside the file', () => {
    // Common case: no panel at all.
    expect(describePhotoWarning(0, [])).toBeNull();
    expect(describePhotoWarning(null, null)).toBeNull();
  });

  it('names the missing folders and says the coins are fine', () => {
    const text = describePhotoWarning(37, ['Z:\\OtherPC\\Coins'])!;

    expect(text).toContain('37 photographs');
    expect(text).toContain('Z:\\OtherPC\\Coins');
    expect(text).toMatch(/not on this computer/i);
    // Reassure: only the link to the picture files doesn't travel, not the collection.
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
    // The photo-relocation tool isn't built, so nothing promises one.
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
    // The recovery steps must be on screen, not in a log.
    const lines = describeRestoreOutcome(outcome);
    const text = lines.join(' ');

    expect(text).toContain(outcome.previousCollectionMovedTo!);
    expect(text).toMatch(/not deleted/i);
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

// Messages for choosing a backup file and explaining disabled buttons.

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
    // An empty folder is a normal outcome; the sentence names the folder and likely causes.
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
    // While running, the progress bar and Cancel button explain the disabled button.
    expect(describeBackupBlock('', true)).toBeNull();
  });
});

describe('describeRestoreBlock', () => {
  it('*** contradicts the belief that the box is filled in ***', () => {
    // An empty box showing grey placeholder text can look filled in; the reason
    // must say that the grey text is only an example.
    const reason = describeRestoreBlock('', false, false)!;

    expect(reason).toMatch(/no backup file is chosen yet/i);
    expect(reason).toMatch(/grey text in the box is an example, not a value/i);
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
