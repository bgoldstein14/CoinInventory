/**
 * Backup and restore panel of the Settings dialog. Runs under Node without
 * jsdom: behaviour is checked on the class, markup against the template text.
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

/** The template with comments stripped, so assertions only see markup. */
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

/** The modal with the backup endpoints stubbed (getBackupSuggestion runs in the constructor). */
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
    // Empty folder by default.
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
    const { modal, api } = createModal();
    await settle();

    expect(api.getBackupSuggestion).toHaveBeenCalled();
    expect(modal['backupDirectory']()).toBe('C:\\Users\\You\\Desktop');
    expect(modal['backupFileName']()).toBe('coin-inventory-backup-2026-11-14-1432.db');
  });

  it('says how big the collection is BEFORE the user picks a folder', async () => {
    const { modal } = createModal();
    await settle();
    expect(modal['databaseSizeLabel']()).toBe('612.3 MB');
  });

  it('does not overwrite a path the user has already typed', async () => {
    // The suggestion arrives asynchronously after the user has typed.
    const { modal } = createModal();
    modal['setBackupDirectory']('D:\\Archive');
    await settle();
    expect(modal['backupDirectory']()).toBe('D:\\Archive');
  });

  it('opens normally when the server cannot be reached', async () => {
    const { modal } = createModal({
      getBackupSuggestion: vi.fn(() => throwError(() => new Error('offline')))
    });
    await settle();
    expect(modal['backupDirectory']()).toBe('');
    expect(modal['databaseSizeLabel']()).toBeNull();
  });

  it('reports the finished file in full', async () => {
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
    const { modal } = createModal();
    expect(() => modal.ngOnDestroy()).not.toThrow();
    expect(modal['backup'].canCancel).toBe(false);
  });

  it('has a Cancel button and a real progress bar', () => {
    const template = settingsTemplate();
    expect(template).toContain('Cancel backup');
    expect(template).toContain('backupCanCancel()');
    expect(template).toContain('backup-progress-fill');
    expect(template).toContain('role="progressbar"');
  });

  it('tells the user they can keep working while it runs', () => {
    // The online backup API allows the app to stay in use.
    expect(settingsTemplate()).toMatch(/keep using the app while this runs/i);
  });

  it('promises not to overwrite an existing backup', () => {
    // `\s+` because the sentence wraps in the markup.
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
    const { modal } = createModal();
    modal['setRestorePath']('C:\\backup.db');
    await modal['checkBackupFile']();

    const contents = modal['backupContents']().join(' ');
    expect(contents).toContain('412 coins');
    expect(contents).toContain('14 Nov 2026');
    expect(modal['restoreConsequence']()).toMatch(/not deleted/i);
  });

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
    // No contents summary for a refused file.
    expect(modal['backupContents']()).toEqual([]);
    expect(modal['restoreConsequence']()).toBeNull();

    await modal['confirmRestore']();
    expect(api.restoreBackup).not.toHaveBeenCalled();
  });

  it('throws away a stale verdict the moment the path is edited', async () => {
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
    // No server restart is needed; only the page is stale.
    const template = settingsTemplate();
    expect(template).toContain('Reload Coin Inventory');
    expect(template).toContain('reloadAfterRestore()');
    expect(template).toMatch(/does not need to be reinstalled or restarted/i);
  });

  it('puts the restore behind two deliberate presses, like the backfill', () => {
    const template = settingsTemplate();
    expect(template).toContain('Check this file');
    expect(template).toContain('Replace my collection with this backup');
    expect(template).toContain('inspectionAcceptable()');
  });

  it('tells the user up front that their collection is kept, not deleted', () => {
    expect(settingsTemplate()).toMatch(/current collection is not deleted/i);
  });
});

describe('SettingsModal — the rest of the dialog is untouched', () => {
  it('still has the transactions preference, the photograph settings and the backfill', () => {
    const template = settingsTemplate();
    expect(template).toContain('Show transactions section in details');
    expect(template).toContain('imageStorageMode');
    expect(template).toContain('max-stored-image-mb');
    expect(template).toContain('Backfill precious-metal data');
  });

  it('still does not link to Reference Data', () => {
    const template = settingsTemplate();
    expect(template).not.toContain('Open Reference Data');
  });
});

describe('SettingsModal — the empty box, and why the buttons are off', () => {
  it('*** says why "Check this file" is disabled, rather than leaving it dead ***', async () => {
    // A placeholder can be mistaken for a value, so the reason says otherwise.
    const { modal } = createModal();
    await settle();

    const reason = modal['restoreBlockReason']()!;
    expect(reason).toMatch(/no backup file is chosen yet/i);
    expect(reason).toMatch(/grey text in the box is an example, not a value/i);

    modal['setRestorePath']('C:\\Users\\You\\Desktop\\backup.db');
    expect(modal['restoreBlockReason']()).toBeNull();
  });

  it('marks the restore box as empty so it does not read as filled in', async () => {
    const { modal } = createModal();
    await settle();

    // Only the "look in" folder is prefilled, not the restore path.
    expect(modal['restorePathEmpty']()).toBe(true);
    modal['setRestorePath']('C:\\backup.db');
    expect(modal['restorePathEmpty']()).toBe(false);
  });

  it('draws the empty state differently and drops the path-shaped watermark', () => {
    const template = settingsTemplate();
    expect(template).toContain('backup-path-input--empty');
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
    // The browser only reveals the folder name, so the note must say it's a guess.
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
    const listBackupFiles = vi.fn(() => of(twoFiles));
    const { modal } = createModal({ listBackupFiles });
    await settle();

    await modal['listRestoreBackups']();

    expect(listBackupFiles).toHaveBeenCalledWith('C:\\Users\\You\\Desktop');
    const shown = modal['restoreFolderFiles']();
    expect(shown).toHaveLength(2);
    expect(shown[0].detail).toContain('612.3 MB');
    expect(shown[0].detail).toContain('14 Nov 2026');
  });

  it('seeds the "look in" folder from the server, but not the file box', async () => {
    const { modal } = createModal();
    await settle();

    expect(modal['restoreFolder'].folder()).toBe('C:\\Users\\You\\Desktop');
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
    // Choosing a file must not inspect or restore.
    expect(api.inspectBackup).not.toHaveBeenCalled();
    expect(api.restoreBackup).not.toHaveBeenCalled();
  });

  it('says plainly when a folder holds no backups at all', async () => {
    const { modal } = createModal({
      listBackupFiles: vi.fn(() => of({ ...twoFiles, files: [] }))
    });
    await settle();

    await modal['listRestoreBackups']();

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

    expect(modal['restoreFolder'].error()).toContain('D:\\Backpus');
    expect(modal['restoreFolderSummary']()).toBeNull();
  });

  it('keeps a pasted path working even with a list on screen', async () => {
    const { modal, api } = createModal({ listBackupFiles: vi.fn(() => of(twoFiles)) });
    await settle();
    await modal['listRestoreBackups']();

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
