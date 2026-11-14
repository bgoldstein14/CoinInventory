/**
 * list-db-files.spec.ts — the two properties that make the listing safe.
 *
 * This module reads a directory whose path the CLIENT chooses, so most of
 * what is asserted below is not "does it work" but "what does it refuse to
 * tell you":
 *
 *   ONLY `*.db`        a folder full of .env, .log and .txt comes back
 *                      with none of them in it, so the endpoint cannot be
 *                      used to enumerate a directory.
 *   ONE FOLDER         a `.db` sitting in a SUB-folder is not listed, and
 *                      neither is one in the PARENT, so naming a folder
 *                      says nothing about its neighbours.
 *
 * The rest — newest-first, size and date, the three ways a folder can be
 * unnameable — exists because the dialog shows them to someone choosing
 * which file replaces their collection.
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
    // The security property. Everything that is not a database is absent
    // from the answer entirely, so this cannot be used as "read me the
    // contents of C:\Users\You".
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
    // `path.extname`, not `includes('.db')`: `notes.db.txt` is a text file
    // and `.db` on its own is a hidden file, not a database.
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
    // No recursion. A backup two folders down is not this folder's
    // business, and recursing would turn one click into a disk crawl.
    const child = path.join(root, 'nested');
    fs.mkdirSync(child);
    writeFile(child, 'hidden-away.db');
    writeFile(root, 'here.db');

    expect(listBackupFiles(root).files.map((file) => file.name)).toEqual(['here.db']);
  });

  it('never leaves the folder it was given — not upward', () => {
    // Naming a folder must say nothing about its parent or its siblings.
    const child = path.join(root, 'inner');
    fs.mkdirSync(child);
    writeFile(root, 'in-the-parent.db');
    writeFile(child, 'in-here.db');

    expect(listBackupFiles(child).files.map((file) => file.name)).toEqual(['in-here.db']);
  });

  it('does not offer a DIRECTORY called something.db as a file', () => {
    // Restoring one would be an EISDIR deep inside the swap.
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
    // A normal outcome: the user guessed a folder, or has not backed up
    // yet. It must be distinguishable from "no such folder".
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
    // "There is no folder called D:\Backpus" is the message that finds a
    // typo; an empty list would send the user looking for lost backups.
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
    // The likeliest mistake once a file picker exists: pasting the path of
    // the backup itself into the folder box.
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
