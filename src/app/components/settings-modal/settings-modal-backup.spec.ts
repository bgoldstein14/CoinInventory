/**
 * settings-modal-backup.spec.ts — §16's half of the Settings dialog.
 *
 * ITS OWN FILE, not more cases bolted onto settings-modal.spec.ts. That
 * file has one subject — "settings, and nothing else", the story of the
 * reference-list editors that were removed and must not come back — and
 * the backup panel is a different subject with a different danger. Two
 * hundred lines about restoring a collection in the middle of it would
 * bury the thing that file exists to protect.
 *
 * What is asserted here is what the component GUARANTEES, not what it
 * paints. The suite runs under Node with NO jsdom, so there is no
 * rendering: behaviour is checked on the class, and the few things that
 * genuinely live in the markup are checked against the template text with
 * its comments stripped.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import '@angular/compiler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { InventoryService } from '../../services/inventory.service';
import { StorageService } from '../../services/storage.service';
import { SettingsModal } from './settings-modal';
import { createTestInventoryService } from '../../testing/test-helpers';

/**
 * The template with its comments removed.
 *
 * *** REQUIRED, NOT TIDINESS — and the escape is `[\s\S]`, never `[sS]`. ***
 * The comments in this template explain at length why the user types a
 * path, what the Cancel button is for and what happens to the previous
 * collection, and they NAME every phrase the assertions below look for.
 * Matching against the raw text would match the prose and pass with the
 * controls missing — which is exactly the failure these tests exist to
 * catch.
 */
function settingsTemplate(): string {
  return readFileSync(join(__dirname, 'settings-modal.html'), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    ''
  );
}

function runningJob() {
  return {
    id: 'job-1',
    state: 'running',
    destination: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
    percent: 0,
    totalPages: 10,
    copiedPages: 0,
    startedAt: '2026-11-14T10:00:00.000Z',
    finishedAt: null,
    result: null,
    error: null
  };
}

function finishedJob() {
  return {
    ...runningJob(),
    state: 'done',
    percent: 100,
    finishedAt: '2026-11-14T10:00:05.000Z',
    result: {
      path: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
      fileSizeBytes: 612_300_000,
      pagesCopied: 10,
      coinCount: 412,
      takenAt: '2026-11-14T10:00:05.000Z',
      schemaVersion: 1
    }
  };
}

function goodInspection(overrides: Record<string, unknown> = {}) {
  return {
    path: 'C:\\Users\\You\\Desktop\\backup.db',
    fileSizeBytes: 612_300_000,
    decision: { verdict: 'ok', acceptable: true, message: 'fine', missingTables: [] },
    schemaVersion: 1,
    coinCount: 412,
    imageCount: 0,
    storedImageCount: 0,
    referencedOnlyImageCount: 0,
    referencedFolders: [] as Array<{ folder: string; presentOnThisMachine: boolean }>,
    provenance: { takenAt: '2026-11-14T09:15:00.000Z', recordedCoinCount: 412 },
    ...overrides
  };
}

function restoreResult(overrides: Record<string, unknown> = {}) {
  return {
    restoredFrom: 'C:\\Users\\You\\Desktop\\backup.db',
    databasePath: 'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.db',
    previousCollectionMovedTo:
      'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.replaced-2026-11-14-162030.db',
    coinCount: 412,
    referencedOnlyImageCount: 0,
    missingPhotoFolders: [] as string[],
    takenAt: '2026-11-14T09:15:00.000Z',
    serverRestartRequired: false,
    ...overrides
  };
}

/**
 * The modal, with the six §16 endpoints stubbed.
 *
 * `getBackupSuggestion` is called from the CONSTRUCTOR, so every test
 * here goes through it whether it cares or not.
 */
function createModal(apiOverrides: Record<string, unknown> = {}) {
  const { inv, storage } = createTestInventoryService();

  const api = {
    getBackupSuggestion: vi.fn(() =>
      of({
        directory: 'C:\\Users\\You\\Desktop',
        fileName: 'coin-inventory-backup-2026-11-14-1432.db',
        databasePath: 'C:\\Users\\You\\AppData\\Local\\CoinInventory\\coin-inventory.db',
        databaseSizeBytes: 612_300_000
      })
    ),
    // The folder listing. Empty by default: most tests here are not
    // about choosing a file, and an empty folder is the answer that
    // changes nothing for them.
    listBackupFiles: vi.fn(() =>
      of({ directory: 'C:\\Users\\You\\Desktop', files: [], truncated: false })
    ),
    startBackup: vi.fn(() => of(runningJob())),
    getBackupJob: vi.fn(() => of(finishedJob())),
    cancelBackup: vi.fn(() => of({ accepted: true })),
    inspectBackup: vi.fn(() => of(goodInspection())),
    restoreBackup: vi.fn(() => of(restoreResult())),
    ...apiOverrides
  };

  const injector = Injector.create({
    providers: [
      { provide: InventoryService, useValue: inv },
      { provide: StorageService, useValue: storage },
      { provide: ApiService, useValue: api }
    ]
  });

  const modal = runInInjectionContext(injector, () => new SettingsModal());
  (modal as unknown as Record<string, unknown>)['showTransactionsInDetails'] = () => false;

  return { modal, api, inv, storage };
}

/** Lets the constructor's fire-and-forget prefill settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe('SettingsModal — backup', () => {
  it('prefills the folder and name from the server, not from a hardcoded guess', async () => {
    // A hardcoded default is right on one workstation and wrong on the
    // host — the trap routes/app-info.ts exists to avoid for the image
    // import, and the same answer is used here.
    const { modal, api } = createModal();
    await settle();

    expect(api.getBackupSuggestion).toHaveBeenCalled();
    expect(modal['backupDirectory']()).toBe('C:\\Users\\You\\Desktop');
    expect(modal['backupFileName']()).toBe('coin-inventory-backup-2026-11-14-1432.db');
  });

  it('says how big the collection is BEFORE the user picks a folder', async () => {
    // "This will write 612 MB" is the difference between choosing the
    // Desktop and choosing a nearly full USB stick.
    const { modal } = createModal();
    await settle();
    expect(modal['databaseSizeLabel']()).toBe('612.3 MB');
  });

  it('does not overwrite a path the user has already typed', async () => {
    // The suggestion lands a moment after the dialog opens. Somebody who
    // pasted a path inside that window must not have it silently replaced
    // — the same race the photograph settings guard against.
    const { modal } = createModal();
    modal['setBackupDirectory']('D:\\Archive');
    await settle();
    expect(modal['backupDirectory']()).toBe('D:\\Archive');
  });

  it('opens normally when the server cannot be reached', async () => {
    // Fire-and-forget: a failed prefill leaves an empty box, never a
    // dialog that will not open.
    const { modal } = createModal({
      getBackupSuggestion: vi.fn(() => throwError(() => new Error('offline')))
    });
    await settle();
    expect(modal['backupDirectory']()).toBe('');
    expect(modal['databaseSizeLabel']()).toBeNull();
  });

  it('reports the finished file in full', async () => {
    // A user who cannot find the file they just made does not have a
    // backup, whatever the app believes.
    const { modal } = createModal();
    await modal['startBackup']();

    expect(modal['backupPath']()).toBe(
      'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db'
    );
    expect(modal['backupMessage']()).toContain('412 coins');
    expect(modal['backupRunning']()).toBe(false);
  });

  it('shows the server\'s refusal instead of starting a phantom job', async () => {
    const { modal, api } = createModal({
      startBackup: vi.fn(() =>
        throwError(() => ({ error: { error: 'There is no folder called D:\\Backpus' } }))
      )
    });

    await modal['startBackup']();

    expect(modal['backupMessage']()).toContain('D:\\Backpus');
    expect(modal['backupPath']()).toBeNull();
    expect(api.getBackupJob).not.toHaveBeenCalled();
  });

  it('stops polling when the dialog is destroyed', () => {
    // Without this a closed dialog leaves a request going out every
    // 400 ms for the rest of the session.
    const { modal } = createModal();
    expect(() => modal.ngOnDestroy()).not.toThrow();
    expect(modal['backup'].canCancel).toBe(false);
  });

  it('has a Cancel button and a real progress bar', () => {
    // §16: a multi-gigabyte backup cannot be a frozen window with no
    // progress and no cancel.
    const template = settingsTemplate();
    expect(template).toContain('Cancel backup');
    expect(template).toContain('backupCanCancel()');
    expect(template).toContain('backup-progress-fill');
    expect(template).toContain('role="progressbar"');
  });

  it('tells the user they can keep working while it runs', () => {
    // The whole reason for SQLite's online backup API rather than a file
    // copy: the "close the app before copying your database" warning is
    // not true any more, so the screen says the opposite.
    expect(settingsTemplate()).toMatch(/keep using the app while this runs/i);
  });

  it('promises not to overwrite an existing backup', () => {
    // `\s+` rather than a space: the sentence wraps in the markup, so a
    // literal space would make this test depend on where Prettier broke
    // the line.
    expect(settingsTemplate()).toMatch(/never\s+overwritten/i);
  });
});

describe('SettingsModal — restore', () => {
  it('checks the file first, and changes nothing by doing so', async () => {
    const { modal, api } = createModal();
    modal['setRestorePath']('C:\\Users\\You\\Desktop\\backup.db');

    await modal['checkBackupFile']();

    expect(api.inspectBackup).toHaveBeenCalledWith('C:\\Users\\You\\Desktop\\backup.db');
    expect(api.restoreBackup).not.toHaveBeenCalled();
    expect(modal['inspectionAcceptable']()).toBe(true);
  });

  it('says what is in the file before anything is replaced', async () => {
    // Coin count and date taken: the question the user is actually
    // trying to answer when looking at four similarly named files.
    const { modal } = createModal();
    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();

    const contents = modal['backupContents']().join(' ');
    expect(contents).toContain('412 coins');
    expect(contents).toContain('14 Nov 2026');
    expect(modal['restoreConsequence']()).toMatch(/not deleted/i);
  });

  /* *** THE REFUSAL. *** */
  it('will not restore a backup the server refused', async () => {
    const { modal, api } = createModal({
      inspectBackup: vi.fn(() =>
        of(
          goodInspection({
            decision: {
              verdict: 'newer-schema',
              acceptable: false,
              message:
                'That backup was made by a newer version of Coin Inventory ' +
                '(collection format 2; this version understands up to 1).',
              missingTables: []
            }
          })
        )
      )
    });

    modal['setRestorePath']('C:\\from-the-future.db');
    await modal['checkBackupFile']();

    expect(modal['inspectionAcceptable']()).toBe(false);
    expect(modal['inspectionMessage']()).toMatch(/newer version of Coin Inventory/i);
    // The summary panel stays empty: "0 coins" under a refusal reads as
    // though we looked inside and found it empty.
    expect(modal['backupContents']()).toEqual([]);
    expect(modal['restoreConsequence']()).toBeNull();

    // And pressing the button anyway does nothing. (The server would
    // refuse again regardless — this guard is a courtesy, not the
    // protection.)
    await modal['confirmRestore']();
    expect(api.restoreBackup).not.toHaveBeenCalled();
  });

  it('throws away a stale verdict the moment the path is edited', async () => {
    // A green "valid backup of 412 coins" panel sitting above a path that
    // now points somewhere else is how the wrong file gets restored.
    const { modal, api } = createModal();
    modal['setRestorePath']('C:\\good.db');
    await modal['checkBackupFile']();
    expect(modal['inspectionAcceptable']()).toBe(true);

    modal['setRestorePath']('C:\\something-else.db');

    expect(modal['inspection']()).toBeNull();
    expect(modal['inspectionAcceptable']()).toBe(false);
    await modal['confirmRestore']();
    expect(api.restoreBackup).not.toHaveBeenCalled();
  });

  /* *** THE UNDO BUTTON. *** */
  it('names where the previous collection went, in full', async () => {
    const { modal } = createModal();
    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();
    await modal['confirmRestore']();

    const lines = modal['restoreOutcomeLines']().join(' ');
    expect(lines).toContain('coin-inventory.replaced-2026-11-14-162030.db');
    expect(lines).toMatch(/not deleted/i);
    expect(lines).toMatch(/copy that file back/i);
  });

  /* *** CONSEQUENCE OF PORTABILITY: THE PHOTOGRAPHS. *** */
  it('warns about referenced photographs before the restore, not after', async () => {
    const { modal } = createModal({
      inspectBackup: vi.fn(() =>
        of(
          goodInspection({
            imageCount: 40,
            storedImageCount: 3,
            referencedOnlyImageCount: 37,
            referencedFolders: [{ folder: 'Z:\\OtherPC\\Coins', presentOnThisMachine: false }]
          })
        )
      )
    });

    modal['setRestorePath']('C:\\from-another-pc.db');
    await modal['checkBackupFile']();

    const warning = modal['photoWarning']()!;
    expect(warning).toContain('37 photographs');
    expect(warning).toContain('Z:\\OtherPC\\Coins');
    expect(warning).toMatch(/not on this computer/i);
    // The reassurance: the coins are fine, it is the link that broke.
    expect(warning).toMatch(/restore completely/i);
  });

  it('repeats the photograph warning afterwards rather than relying on memory', async () => {
    const { modal } = createModal({
      restoreBackup: vi.fn(() =>
        of(
          restoreResult({
            referencedOnlyImageCount: 37,
            missingPhotoFolders: ['Z:\\OtherPC\\Coins']
          })
        )
      )
    });

    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();
    await modal['confirmRestore']();

    expect(modal['restoredPhotoWarning']()).toContain('Z:\\OtherPC\\Coins');
  });

  it('shows no photograph warning when every picture is inside the file', async () => {
    const { modal } = createModal();
    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();
    expect(modal['photoWarning']()).toBeNull();
  });

  it('reports a failed restore without claiming the collection changed', async () => {
    const { modal } = createModal({
      restoreBackup: vi.fn(() =>
        throwError(() => ({ error: { error: 'That is not a Coin Inventory collection.' } }))
      )
    });

    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();
    await modal['confirmRestore']();

    expect(modal['restoreError']()).toBe('That is not a Coin Inventory collection.');
    expect(modal['restoreOutcome']()).toBeNull();
    expect(modal['restoring']()).toBe(false);
  });

  it('offers a reload rather than doing it automatically', () => {
    // The backend is already serving the restored collection — no server
    // restart is needed. What is stale is this page. Reloading it from
    // under somebody still reading where their previous collection went
    // is exactly the wrong moment.
    const template = settingsTemplate();
    expect(template).toContain('Reload Coin Inventory');
    expect(template).toContain('reloadAfterRestore()');
    expect(template).toMatch(/does not need to be reinstalled or restarted/i);
  });

  it('puts the restore behind two deliberate presses, like the backfill', () => {
    const template = settingsTemplate();
    expect(template).toContain('Check this file');
    expect(template).toContain('Replace my collection with this backup');
    // ...and the second only exists inside the accepted branch.
    expect(template).toContain('inspectionAcceptable()');
  });

  it('tells the user up front that their collection is kept, not deleted', () => {
    expect(settingsTemplate()).toMatch(/current collection is not deleted/i);
  });
});

describe('SettingsModal — the rest of the dialog is untouched', () => {
  it('still has the transactions preference, the photograph settings and the backfill', () => {
    // §16 added a section; it must not have disturbed the two tidy-ups
    // this dialog had this week.
    const template = settingsTemplate();
    expect(template).toContain('Show transactions section in details');
    expect(template).toContain('imageStorageMode');
    expect(template).toContain('max-stored-image-mb');
    expect(template).toContain('Backfill precious-metal data');
  });

  it('still does not link to Reference Data', () => {
    // Removed at the owner's word and not to come back in a smaller form.
    const template = settingsTemplate();
    expect(template).not.toContain('Open Reference Data');
  });
});

/* =====================================================================
 * AFTER THE OWNER TESTED IT
 * =====================================================================
 *
 * *** "Backup/Restore worked great. However... it wasn't intuitive how
 * to do the restore because the watermarked restore field looked like it
 * was filled in text and it could leave the user bewildered why the
 * buttons weren't enabled." ***
 *
 * Three problems in that paragraph and the third is the one that
 * stopped him. Nothing in the machinery changed: the pinned read
 * snapshot, the six verdicts, the aside file and the job model are all
 * untouched. What changed is how a path gets into a box.
 */

describe('SettingsModal — the empty box, and why the buttons are off', () => {
  it('*** says why "Check this file" is disabled, rather than leaving it dead ***', async () => {
    // THE FAULT: a grey example path in an empty box reads as a value,
    // so the user believed the field was set, and a disabled button
    // offered nothing that could correct the belief.
    const { modal } = createModal();
    await settle();

    const reason = modal['restoreBlockReason']()!;
    expect(reason).toMatch(/no backup file is chosen yet/i);
    // It has to contradict the belief directly.
    expect(reason).toMatch(/grey text in the box is an example, not a value/i);

    // ...and go away the moment there is something to check.
    modal['setRestorePath']('C:\\Users\\You\\Desktop\\backup.db');
    expect(modal['restoreBlockReason']()).toBeNull();
  });

  it('marks the restore box as empty so it does not read as filled in', async () => {
    const { modal } = createModal();
    await settle();

    // The restore path box is NOT prefilled — only the folder to look
    // in is — so this is the state the user actually opens on.
    expect(modal['restorePathEmpty']()).toBe(true);
    modal['setRestorePath']('C:\\backup.db');
    expect(modal['restorePathEmpty']()).toBe(false);
  });

  it('draws the empty state differently and drops the path-shaped watermark', () => {
    const template = settingsTemplate();
    // The box tells the stylesheet when it is empty...
    expect(template).toContain('backup-path-input--empty');
    // ...and the placeholder is words, not a path that can pass for one.
    expect(template).toContain('placeholder="Nothing chosen yet"');
    expect(template).not.toContain(
      'placeholder="C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db"'
    );
  });

  it('puts the reason next to the control and points the button at it', () => {
    const template = settingsTemplate();
    expect(template).toContain('restoreBlockReason()');
    expect(template).toContain('id="restore-blocked-reason"');
    expect(template).toContain('aria-describedby');
  });

  it('explains a disabled "Back up now" too', async () => {
    const { modal } = createModal({
      getBackupSuggestion: vi.fn(() => throwError(() => new Error('offline')))
    });
    await settle();

    // The one time the folder box is empty is when the server could not
    // be reached — exactly when the user has least idea what is wrong.
    expect(modal['backupDirectory']()).toBe('');
    expect(modal['backupBlockReason']()).toMatch(/folder box is empty/i);

    modal['setBackupDirectory']('D:\\Archive');
    expect(modal['backupBlockReason']()).toBeNull();
  });
});

describe('SettingsModal — the folder picker, and what it admits to', () => {
  it('fills the folder box with a guess and says it is one', async () => {
    const { modal } = createModal();
    await settle();

    modal['backupFolder'].acceptPick([
      { name: 'one.db', webkitRelativePath: 'Backups/one.db' }
    ]);

    expect(modal['backupDirectory']()).toBe('C:\\Users\\You\\Desktop\\Backups');
    // *** The honesty requirement: it must not read as though the
    // browser told us where the folder is. It cannot and never will. ***
    expect(modal['backupFolder'].guessNote()).toMatch(/only the folder's NAME/);
  });

  it('still takes a typed UNC path that no picker could reach', async () => {
    const { modal } = createModal();
    await settle();

    modal['setBackupDirectory']('\\\\NAS\\Coin Backups');
    expect(modal['backupDirectory']()).toBe('\\\\NAS\\Coin Backups');
    expect(modal['backupBlockReason']()).toBeNull();
  });

  it('offers a picker on both folder boxes', () => {
    const template = settingsTemplate();
    expect(template).toContain('handleBackupFolderPick($event)');
    expect(template).toContain('handleRestoreFolderPick($event)');
    // A DIRECTORY picker, like the image import's.
    expect(template.match(/webkitdirectory/g)?.length).toBe(2);
  });
});

describe('SettingsModal — picking a backup file instead of typing one', () => {
  const twoFiles = {
    directory: 'C:\\Users\\You\\Desktop',
    files: [
      {
        name: 'coin-inventory-backup-2026-11-14-1432.db',
        path: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
        sizeBytes: 612_300_000,
        modifiedAt: '2026-11-14T16:20:00.000Z'
      },
      {
        name: 'coin-inventory-backup-2026-11-01-0900.db',
        path: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-01-0900.db',
        sizeBytes: 410_000_000,
        modifiedAt: '2026-11-01T09:00:00.000Z'
      }
    ],
    truncated: false
  };

  it('*** lists the .db files the SERVER found, with size and date ***', async () => {
    // The browser cannot read a folder; the server can. That asymmetry
    // is what removes the exact-path typing from the one operation that
    // replaces the whole collection.
    const listBackupFiles = vi.fn(() => of(twoFiles));
    const { modal } = createModal({ listBackupFiles });
    await settle();

    await modal['listRestoreBackups']();

    expect(listBackupFiles).toHaveBeenCalledWith('C:\\Users\\You\\Desktop');
    const shown = modal['restoreFolderFiles']();
    expect(shown).toHaveLength(2);
    // Size AND date, because that is the question being asked of four
    // files with nearly identical names.
    expect(shown[0].detail).toContain('612.3 MB');
    expect(shown[0].detail).toContain('14 Nov 2026');
  });

  it('seeds the "look in" folder from the server, but not the file box', async () => {
    const { modal } = createModal();
    await settle();

    expect(modal['restoreFolder'].folder()).toBe('C:\\Users\\You\\Desktop');
    // The file itself is still a decision. Prefilling it would be the
    // original bug with a real value instead of a grey one.
    expect(modal['restorePath']()).toBe('');
  });

  it('fills the path box when a file is chosen, and does nothing else', async () => {
    const { modal, api } = createModal({ listBackupFiles: vi.fn(() => of(twoFiles)) });
    await settle();
    await modal['listRestoreBackups']();

    modal['chooseBackupFile'](modal['restoreFolderFiles']()[1]);

    expect(modal['restorePath']()).toBe(
      'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-01-0900.db'
    );
    expect(modal['restoreBlockReason']()).toBeNull();
    // *** The two deliberate presses stay two deliberate presses. ***
    // The list removed the typing, not a safeguard.
    expect(api.inspectBackup).not.toHaveBeenCalled();
    expect(api.restoreBackup).not.toHaveBeenCalled();
  });

  it('says plainly when a folder holds no backups at all', async () => {
    const { modal } = createModal({
      listBackupFiles: vi.fn(() => of({ ...twoFiles, files: [] }))
    });
    await settle();

    await modal['listRestoreBackups']();

    // A normal outcome — a guessed folder, or nothing backed up yet —
    // and it must not read as "your backups are gone".
    expect(modal['restoreFolderSummary']()).toMatch(/no backup \(\.db\) files/i);
    expect(modal['restoreFolderFiles']()).toEqual([]);
  });

  it('shows the server own sentence for a folder that is not there', async () => {
    const { modal } = createModal({
      listBackupFiles: vi.fn(() =>
        throwError(() => ({ error: { error: 'There is no folder called D:\\Backpus' } }))
      )
    });
    await settle();

    modal['restoreFolder'].setFolder('D:\\Backpus');
    await modal['listRestoreBackups']();

    // Naming the folder is what finds the typo.
    expect(modal['restoreFolder'].error()).toContain('D:\\Backpus');
    expect(modal['restoreFolderSummary']()).toBeNull();
  });

  it('keeps a pasted path working even with a list on screen', async () => {
    const { modal, api } = createModal({ listBackupFiles: vi.fn(() => of(twoFiles)) });
    await settle();
    await modal['listRestoreBackups']();

    // Somebody pasting a UNC path to a NAS the picker cannot reach must
    // not be blocked by the convenience.
    modal['setRestorePath']('\\\\NAS\\Backups\\coin-inventory-backup.db');
    await modal['checkBackupFile']();

    expect(api.inspectBackup).toHaveBeenCalledWith(
      '\\\\NAS\\Backups\\coin-inventory-backup.db'
    );
  });

  it('renders the list as choices, not as more text to copy', () => {
    const template = settingsTemplate();
    expect(template).toContain('restoreFolderFiles()');
    expect(template).toContain('chooseBackupFile(file)');
    expect(template).toContain('Show backup files in this folder');
  });
});
