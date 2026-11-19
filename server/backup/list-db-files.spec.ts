/**
 * The backup folder listing. The client chooses the folder, so the key
 * properties are what it won't reveal: only `*.db` files, and only in the
 * named folder (not sub-folders or the parent).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BackupDirectoryError, listBackupFiles } from './list-db-files';

let root = '';

/** Writes `name` with `bytes` bytes of filler and an explicit mtime. */
function writeFile(directory: string, name: string, bytes = 8, mtime?: Date): string {
  const full = path.join(directory, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 7));
  if (mtime) fs.utimesSync(full, mtime, mtime);
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-backup-list-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listBackupFiles — what it will not tell you', () => {
  it('names *.db files and nothing else in the folder', () => {
    // Non-database files are omitted entirely.
    writeFile(root, 'coin-inventory-backup-2026-11-14-1432.db');
    writeFile(root, '.env');
    writeFile(root, 'app.log');
    writeFile(root, 'secrets.txt');
    writeFile(root, 'photo.jpg');
    writeFile(root, 'coin-inventory.db-wal');
    writeFile(root, 'coin-inventory.db-shm');

    const listing = listBackupFiles(root);

    expect(listing.files.map((file) => file.name)).toEqual([
      'coin-inventory-backup-2026-11-14-1432.db',
    ]);
  });

  it('is not fooled by a name that merely contains .db', () => {
    // `notes.db.txt` is a text file and `.db` alone is a hidden file.
    writeFile(root, 'notes.db.txt');
    writeFile(root, '.db');
    writeFile(root, 'database');
    writeFile(root, 'real.db');

    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual(['real.db']);
  });

  it('accepts .DB, because Windows does not care about case', () => {
    writeFile(root, 'SHOUTING.DB');
    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual(['SHOUTING.DB']);
  });

  it('never leaves the folder it was given — not downward', () => {
    // No recursion.
    const child = path.join(root, 'nested');
    fs.mkdirSync(child);
    writeFile(child, 'hidden-away.db');
    writeFile(root, 'here.db');

    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual(['here.db']);
  });

  it('never leaves the folder it was given — not upward', () => {
    // Nothing about the parent or siblings.
    const child = path.join(root, 'inner');
    fs.mkdirSync(child);
    writeFile(root, 'in-the-parent.db');
    writeFile(child, 'in-here.db');

    expect(listBackupFiles(child).files.map((file) => file.name)).toEqual(['in-here.db']);
  });

  it('does not offer a DIRECTORY called something.db as a file', () => {
    // A directory named *.db isn't offered.
    fs.mkdirSync(path.join(root, 'looks-like-a-backup.db'));
    writeFile(root, 'actually-a-backup.db');

    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual([
      'actually-a-backup.db',
    ]);
  });
});

describe('listBackupFiles — telling two backups apart', () => {
  it('reports size and modified time for each file', () => {
    writeFile(root, 'one.db', 4096, new Date('2026-11-14T10:00:00.000Z'));

    const [file] = listBackupFiles(root).files;
    expect(file.sizeBytes).toBe(4096);
    expect(file.modifiedAt).toBe('2026-11-14T10:00:00.000Z');
    expect(file.path).toBe(path.join(path.resolve(root), 'one.db'));
  });

  it('puts the newest first, which is the one the user just made', () => {
    writeFile(root, 'oldest.db', 8, new Date('2026-11-01T09:00:00.000Z'));
    writeFile(root, 'newest.db', 8, new Date('2026-11-14T09:00:00.000Z'));
    writeFile(root, 'middle.db', 8, new Date('2026-11-07T09:00:00.000Z'));

    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual([
      'newest.db',
      'middle.db',
      'oldest.db',
    ]);
  });

  it('reports an empty folder as an empty list, not as a failure', () => {
    // An empty folder is normal, and distinct from a missing one.
    const listing = listBackupFiles(root);
    expect(listing.files).toEqual([]);
    expect(listing.truncated).toBe(false);
  });
});

describe('listBackupFiles — folders it cannot list', () => {
  it('refuses an empty folder box with something to type', () => {
    expect(() => listBackupFiles('   ')).toThrowError(BackupDirectoryError);
    try {
      listBackupFiles('');
    } catch (err) {
      expect((err as BackupDirectoryError).kind).toBe('empty');
      expect((err as Error).message).toMatch(/Enter the folder/i);
    }
  });

  it('says a missing folder is missing, and names what was asked for', () => {
    // A missing folder gets its own message, so typos are obvious.
    const absent = path.join(root, 'not-here');
    try {
      listBackupFiles(absent);
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupDirectoryError);
      expect((err as BackupDirectoryError).kind).toBe('missing');
      expect((err as Error).message).toContain(absent);
    }
  });

  it('says so when the path is a file rather than a folder', () => {
    // Pasting the backup file's path into the folder box.
    const file = writeFile(root, 'backup.db');
    try {
      listBackupFiles(file);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as BackupDirectoryError).kind).toBe('not-a-folder');
      expect((err as Error).message).toMatch(/is a file, not a folder/i);
    }
  });
});
