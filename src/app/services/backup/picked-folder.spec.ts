/**
 * Tests for picked-folder: a browser picker gives only the folder's name, so
 * the full path is a guess and the UI must say so.
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
    // An empty folder arrives as an empty file list, so the browser never names it.
    expect(folderNameFromPicker([])).toBeNull();
    expect(folderNameFromPicker(null)).toBeNull();
  });

  it('returns null for a plain multi-file pick', () => {
    // Without `webkitdirectory` there is no relative path: files but no folder.
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
    // Common case: the user picks the folder the box already shows.
    expect(guessFolderPath('D:\\Backups', 'Backups')).toBe('D:\\Backups');
    expect(guessFolderPath('D:\\backups', 'BACKUPS')).toBe('D:\\backups');
  });

  it('does not double the separator when the box has a trailing one', () => {
    expect(guessFolderPath('D:\\Archive\\', 'Backups')).toBe('D:\\Archive\\Backups');
  });

  it('keeps a UNC prefix intact', () => {
    // Must not eat the leading \\ of a UNC path.
    expect(guessFolderPath('\\\\NAS\\Share', 'Backups')).toBe('\\\\NAS\\Share\\Backups');
  });

  it('returns the bare name when there is nothing to anchor it to', () => {
    // No box: return the bare name rather than discard it.
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
    // Must not read as though the browser supplied the path.
    expect(note).toMatch(/only the folder's NAME/);
    expect(note).toMatch(/assumed/i);
  });

  it('explains an empty folder rather than failing silently', () => {
    // No files came back, so the box is unchanged and the note explains why.
    const note = describeFolderGuess(null, 'C:\\Users\\You\\Desktop', false);
    expect(note).toMatch(/empty folder is invisible/i);
    expect(note).toMatch(/type or paste/i);
  });

  it('explains a plain multi-file pick, which is a different nothing', () => {
    const note = describeFolderGuess(null, 'C:\\Users\\You\\Desktop', true);
    expect(note).toMatch(/files rather than a folder/i);
  });
});
