/**
 * backup/names.spec.ts — the names, and the two rules hidden in them.
 *
 *   1. a backup never overwrites a backup (uniqueFileName)
 *   2. the displaced collection is findable and recoverable (asideFileName)
 *
 * Both are pure string work, which is the point: they are the sort of
 * thing that is easy to get subtly wrong — a timezone, a dot in the wrong
 * place, a second collision — and impossible to notice until the day it
 * matters.
 */

import { describe, expect, it } from 'vitest';

import {
  asideFileName,
  backupFileName,
  describeBadDestination,
  isAbsolutePath,
  minuteStamp,
  secondStamp,
  uniqueFileName,
} from './names';

/** 14 November 2026, 14:32:15 LOCAL — the names are built from local time. */
const when = new Date(2026, 10, 14, 14, 32, 15);

describe('timestamps', () => {
  it('writes local date and time, zero-padded', () => {
    expect(minuteStamp(when)).toBe('2026-11-14-1432');
    expect(secondStamp(when)).toBe('2026-11-14-143215');
  });

  it('pads single digits, so names sort correctly', () => {
    const early = new Date(2026, 0, 2, 3, 4, 5);
    expect(secondStamp(early)).toBe('2026-01-02-030405');
  });

  it('uses LOCAL time, not UTC', () => {
    // The user reads this in a folder on their own desktop. A backup taken
    // at nine in the evening that is named for a UTC hour is a file they
    // will not recognise.
    const local = new Date(2026, 10, 14, 21, 0, 0);
    expect(minuteStamp(local)).toBe('2026-11-14-2100');
    expect(local.getHours()).toBe(21);
  });
});

describe('backupFileName', () => {
  it('is a .db named for when it was taken', () => {
    expect(backupFileName(when)).toBe('coin-inventory-backup-2026-11-14-1432.db');
  });

  it('contains nothing Windows forbids in a file name', () => {
    expect(backupFileName(when)).not.toMatch(/[<>:"/\\|?*]/);
  });
});

describe('asideFileName — the undo button', () => {
  it('keeps the stem and the extension, and says what happened', () => {
    expect(asideFileName('coin-inventory.db', when)).toBe(
      'coin-inventory.replaced-2026-11-14-143215.db'
    );
  });

  it('sorts next to the collection it came from', () => {
    const aside = asideFileName('coin-inventory.db', when);
    // Same prefix, so a user listing the folder alphabetically finds it
    // immediately below the file they were looking for.
    expect(aside.startsWith('coin-inventory')).toBe(true);
  });

  it('stays a .db, so copying it back IS the recovery', () => {
    expect(asideFileName('coin-inventory.db', when).endsWith('.db')).toBe(true);
  });

  it('is unique to the SECOND, so two restores cannot collide', () => {
    const first = asideFileName('coin-inventory.db', new Date(2026, 10, 14, 14, 32, 15));
    const second = asideFileName('coin-inventory.db', new Date(2026, 10, 14, 14, 32, 16));
    expect(first).not.toBe(second);
  });

  it('copes with a name that has no extension', () => {
    expect(asideFileName('collection', when)).toBe('collection.replaced-2026-11-14-143215.db');
  });

  it('copes with a name with several dots', () => {
    expect(asideFileName('my.coins.v2.db', when)).toBe(
      'my.coins.v2.replaced-2026-11-14-143215.db'
    );
  });
});

describe('uniqueFileName — a backup never overwrites a backup', () => {
  it('returns the name unchanged when nothing is in the way', () => {
    expect(uniqueFileName('backup.db', () => false)).toBe('backup.db');
  });

  it('adds (2) before the extension, where Explorer puts it', () => {
    expect(uniqueFileName('backup.db', (name) => name === 'backup.db')).toBe('backup (2).db');
  });

  it('keeps counting past the second collision', () => {
    const taken = new Set(['backup.db', 'backup (2).db', 'backup (3).db']);
    expect(uniqueFileName('backup.db', (name) => taken.has(name))).toBe('backup (4).db');
  });

  it('keeps the file a .db, so the suffix cannot break the restore', () => {
    const result = uniqueFileName('backup.db', (name) => name === 'backup.db');
    expect(result.endsWith('.db')).toBe(true);
  });

  it('gives up loudly rather than silently overwriting', () => {
    // A thousand same-named files in one folder means something is badly
    // wrong, and a random suffix would paper over it.
    expect(() => uniqueFileName('backup.db', () => true, 5)).toThrow(/free name/i);
  });
});

describe('describeBadDestination', () => {
  const ok = 'C:\\Users\\Someone\\Desktop';

  it('passes a sensible Windows folder and name', () => {
    expect(describeBadDestination(ok, 'coin-inventory-backup.db')).toBeNull();
  });

  it('asks for a folder when the box is empty', () => {
    expect(describeBadDestination('  ', 'a.db')).toMatch(/choose a folder/i);
  });

  it('asks for a name when the name is empty', () => {
    expect(describeBadDestination(ok, '   ')).toMatch(/name/i);
  });

  it('refuses a RELATIVE path, which would land where the user cannot find it', () => {
    // It would resolve against the server's working directory — somewhere
    // inside the install folder — and the user would be told their backup
    // succeeded and never see the file again.
    expect(describeBadDestination('backups', 'a.db')).toMatch(/full path/i);
    expect(describeBadDestination('.\\backups', 'a.db')).toMatch(/full path/i);
  });

  it('refuses characters Windows will not store', () => {
    expect(describeBadDestination(ok, 'my:backup.db')).toMatch(/cannot contain/i);
    expect(describeBadDestination(ok, 'back\\up.db')).toMatch(/cannot contain/i);
  });

  it('insists on .db, so the file opens as what it is', () => {
    expect(describeBadDestination(ok, 'collection.xlsx')).toMatch(/\.db/);
    expect(describeBadDestination(ok, 'collection')).toMatch(/\.db/);
  });

  it('accepts .DB in any case', () => {
    expect(describeBadDestination(ok, 'Collection.DB')).toBeNull();
  });
});

describe('isAbsolutePath', () => {
  it('accepts a drive letter and a UNC share', () => {
    expect(isAbsolutePath('C:\\Users')).toBe(true);
    expect(isAbsolutePath('c:/users')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('accepts a POSIX path, so the specs run anywhere', () => {
    expect(isAbsolutePath('/home/someone')).toBe(true);
  });

  it('rejects a bare drive letter with no separator', () => {
    // `C:backups` means "the backups folder in the CURRENT directory on
    // C:", which is not where anybody thinks it is.
    expect(isAbsolutePath('C:backups')).toBe(false);
  });

  it('rejects relative paths', () => {
    expect(isAbsolutePath('backups')).toBe(false);
    expect(isAbsolutePath('./backups')).toBe(false);
    expect(isAbsolutePath('..\\backups')).toBe(false);
  });
});
