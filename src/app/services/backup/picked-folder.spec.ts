/**
 * picked-folder.spec.ts — what a folder picker really gives us.
 *
 * The thing these tests exist to stop is a future change that quietly
 * starts presenting the guess as a fact. A browser cannot tell a page
 * where a folder is; everything here is arithmetic on a NAME plus an
 * assumption, and the assumption has to keep saying so.
 */

import { describe, expect, it } from 'vitest';

import {
  describeFolderGuess,
  folderNameFromPicker,
  guessFolderPath,
  type PickedFile,
} from './picked-folder';

const file = (webkitRelativePath: string, name = 'x.db'): PickedFile => ({
  name,
  webkitRelativePath,
});

describe('folderNameFromPicker', () => {
  it('reads the folder name out of the first file', () => {
    expect(
      folderNameFromPicker([
        file('Backups/coin-inventory-backup-2026-11-14-1432.db'),
        file('Backups/older.db'),
      ])
    ).toBe('Backups');
  });

  it('takes only the first segment, never the sub-folders', () => {
    expect(folderNameFromPicker([file('Backups/2026/November/one.db')])).toBe('Backups');
  });

  it('returns null for an EMPTY folder, which is a real case', () => {
    // A directory picker reports the FILES inside a folder. An empty
    // folder therefore arrives as an empty list and the browser never
    // names it. Not an error — the platform — and the UI has to say so
    // rather than silently leaving the box as it was.
    expect(folderNameFromPicker([])).toBeNull();
    expect(folderNameFromPicker(null)).toBeNull();
  });

  it('returns null for a plain multi-file pick', () => {
    // No `webkitdirectory`, so no relative path on any file: we have
    // files but still no folder.
    expect(folderNameFromPicker([{ name: 'backup.db' }, { name: 'other.db' }])).toBeNull();
  });
});

describe('guessFolderPath', () => {
  it('assumes the picked folder sits inside the one already in the box', () => {
    expect(guessFolderPath('C:\\Users\\You\\Desktop', 'Backups')).toBe(
      'C:\\Users\\You\\Desktop\\Backups'
    );
  });

  it('leaves the box alone when it already ends in that folder', () => {
    // The commonest pick of all: the user opens the picker on the folder
    // the box is already showing, just to confirm it.
    expect(guessFolderPath('D:\\Backups', 'Backups')).toBe('D:\\Backups');
    expect(guessFolderPath('D:\\backups', 'BACKUPS')).toBe('D:\\backups');
  });

  it('does not double the separator when the box has a trailing one', () => {
    expect(guessFolderPath('D:\\Archive\\', 'Backups')).toBe('D:\\Archive\\Backups');
  });

  it('keeps a UNC prefix intact', () => {
    // Stripping trailing separators must never eat the leading \\ of a
    // network path — that is the one kind of path a picker cannot reach
    // and the user has to be able to type.
    expect(guessFolderPath('\\\\NAS\\Share', 'Backups')).toBe('\\\\NAS\\Share\\Backups');
  });

  it('returns the bare name when there is nothing to anchor it to', () => {
    // Not a path, and the caller says so. Throwing it away would discard
    // the one thing the picker did tell us.
    expect(guessFolderPath('', 'Backups')).toBe('Backups');
  });

  it('changes nothing when the picker named nothing', () => {
    expect(guessFolderPath('C:\\Users\\You\\Desktop', null)).toBe('C:\\Users\\You\\Desktop');
  });
});

describe('describeFolderGuess', () => {
  it('names the folder, names the guess, and says which half to fix', () => {
    const note = describeFolderGuess('Backups', 'C:\\Users\\You\\Desktop\\Backups', true);

    expect(note).toContain('"Backups"');
    expect(note).toContain('C:\\Users\\You\\Desktop\\Backups');
    // The honesty requirement: it must not read as though the path came
    // from the browser.
    expect(note).toMatch(/only the folder's NAME/);
    expect(note).toMatch(/assumed/i);
  });

  it('explains an empty folder rather than failing silently', () => {
    // No files came back, so the browser never named the folder. The
    // box is unchanged and the user is owed a reason.
    const note = describeFolderGuess(null, 'C:\\Users\\You\\Desktop', false);
    expect(note).toMatch(/empty folder is invisible/i);
    expect(note).toMatch(/type or paste/i);
  });

  it('explains a plain multi-file pick, which is a different nothing', () => {
    const note = describeFolderGuess(null, 'C:\\Users\\You\\Desktop', true);
    expect(note).toMatch(/files rather than a folder/i);
  });
});
