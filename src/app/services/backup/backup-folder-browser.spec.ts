/**
 * backup-folder-browser.spec.ts — the folder box, its picker and the
 * server's answer about it.
 *
 * Run under Node with no jsdom and no TestBed: the class is a plain
 * object holding signals and takes its one dependency as a function, for
 * the same reason BackupRunner does.
 */

import { describe, expect, it, vi } from 'vitest';

import { BackupFolderBrowser } from './backup-folder-browser';
import type { BackupDirectoryListing } from './backup-messages';

const listing = (
  overrides: Partial<BackupDirectoryListing> = {}
): BackupDirectoryListing => ({
  directory: 'C:\\Users\\You\\Desktop',
  files: [
    {
      name: 'coin-inventory-backup-2026-11-14-1432.db',
      path: 'C:\\Users\\You\\Desktop\\coin-inventory-backup-2026-11-14-1432.db',
      sizeBytes: 612_300_000,
      modifiedAt: '2026-11-14T16:20:00.000Z',
    },
  ],
  truncated: false,
  ...overrides,
});

describe('BackupFolderBrowser — typing and pasting', () => {
  it('keeps whatever the user types, picker or no picker', () => {
    // The UNC case. A convenience that cannot reach a NAS must not stop
    // somebody pasting a path that can.
    const browser = new BackupFolderBrowser(async () => listing());
    browser.setFolder('\\\\NAS\\Backups');
    expect(browser.folder()).toBe('\\\\NAS\\Backups');
  });

  it('throws away a listing the moment the folder is edited', () => {
    // The same trap a stale inspection verdict is: a list of files under
    // a path that now points somewhere else.
    const browser = new BackupFolderBrowser(async () => listing());
    browser.listing.set(listing());

    browser.setFolder('D:\\Somewhere else');

    expect(browser.listing()).toBeNull();
    expect(browser.guessNote()).toBeNull();
  });
});

describe('BackupFolderBrowser — the picker, and what it cannot do', () => {
  it('fills the box with a GUESS and discloses that it is one', () => {
    const browser = new BackupFolderBrowser(async () => listing());
    browser.setFolder('C:\\Users\\You\\Desktop');

    browser.acceptPick([
      { name: 'one.db', webkitRelativePath: 'Backups/one.db' },
      { name: 'two.db', webkitRelativePath: 'Backups/two.db' },
    ]);

    expect(browser.folder()).toBe('C:\\Users\\You\\Desktop\\Backups');
    // *** The honesty requirement. *** The note must still be there, and
    // must not read as though the browser supplied the path.
    expect(browser.guessNote()).toMatch(/only the folder's NAME/);
    expect(browser.guessNote()).toContain('C:\\Users\\You\\Desktop\\Backups');
  });

  it('leaves the box alone for an empty folder, and says why', () => {
    // A browser reports the files in a folder, so an empty one is
    // invisible to it. Silently doing nothing would look like a bug.
    const browser = new BackupFolderBrowser(async () => listing());
    browser.setFolder('C:\\Users\\You\\Desktop');

    browser.acceptPick([]);

    expect(browser.folder()).toBe('C:\\Users\\You\\Desktop');
    expect(browser.guessNote()).toMatch(/empty folder is invisible/i);
  });

  it('keeps the disclosure up even after the folder lists successfully', async () => {
    // A successful listing proves the folder EXISTS. It does not prove
    // it is the one the user picked — C:\Desktop\Backups and D:\Backups
    // can both be real.
    const browser = new BackupFolderBrowser(async () => listing());
    browser.setFolder('C:\\Users\\You\\Desktop');
    browser.acceptPick([{ name: 'one.db', webkitRelativePath: 'Backups/one.db' }]);

    await browser.refresh();

    expect(browser.listing()).not.toBeNull();
    expect(browser.guessNote()).toMatch(/assumed/i);
  });
});

describe('BackupFolderBrowser — asking the server', () => {
  it('passes the trimmed folder through and keeps the answer', async () => {
    const list = vi.fn(async () => listing());
    const browser = new BackupFolderBrowser(list);
    browser.setFolder('  C:\\Users\\You\\Desktop  ');

    await browser.refresh();

    expect(list).toHaveBeenCalledWith('C:\\Users\\You\\Desktop');
    expect(browser.listing()?.files).toHaveLength(1);
    expect(browser.busy()).toBe(false);
  });

  it('does not ask about an empty box', async () => {
    const list = vi.fn(async () => listing());
    const browser = new BackupFolderBrowser(list);

    await browser.refresh();

    expect(list).not.toHaveBeenCalled();
  });

  it('shows the server sentence, which is what finds a typo', async () => {
    // "There is no folder called D:\Backpus" is the whole value of the
    // 404. A generic failure message would send the user looking for
    // lost backups instead of at the spelling.
    const browser = new BackupFolderBrowser(async () => {
      throw { error: { error: 'There is no folder called D:\\Backpus' } };
    });
    browser.setFolder('D:\\Backpus');

    await browser.refresh();

    expect(browser.error()).toBe('There is no folder called D:\\Backpus');
    expect(browser.listing()).toBeNull();
    expect(browser.busy()).toBe(false);
  });

  it('reports an empty folder as an empty list, not as a failure', async () => {
    const browser = new BackupFolderBrowser(async () => listing({ files: [] }));
    browser.setFolder('C:\\Users\\You\\Desktop');

    await browser.refresh();

    expect(browser.error()).toBeNull();
    expect(browser.listing()?.files).toEqual([]);
  });
});
