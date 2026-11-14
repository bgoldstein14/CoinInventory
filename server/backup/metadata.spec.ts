/**
 * backup/metadata.spec.ts — the round trip, and the nulls.
 *
 * The round trip is easy. The nulls are the test that matters: every
 * backup taken before this feature existed has no stamp at all, and a
 * reader that threw, or that invented a date, would turn "I cannot tell
 * you when this was taken" into either a crash or a lie — in a dialog
 * whose whole job is to help somebody tell two files apart.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKUP_DESCRIPTION,
  COIN_COUNT_KEY,
  DESCRIPTION_KEY,
  SCHEMA_VERSION_KEY,
  TAKEN_AT_KEY,
  buildBackupMetadata,
  readBackupProvenance,
} from './metadata';

describe('buildBackupMetadata', () => {
  const stamp = {
    takenAt: new Date('2026-11-14T15:04:05.000Z'),
    coinCount: 412,
    schemaVersion: 1,
  };

  it('records the date in ISO-8601 UTC, because a machine reads it back', () => {
    expect(buildBackupMetadata(stamp)[TAKEN_AT_KEY]).toBe('2026-11-14T15:04:05.000Z');
  });

  it('records the coin count and the schema version', () => {
    const metadata = buildBackupMetadata(stamp);
    expect(metadata[COIN_COUNT_KEY]).toBe('412');
    expect(metadata[SCHEMA_VERSION_KEY]).toBe('1');
  });

  it('says what the file is, for whoever opens it in five years', () => {
    expect(buildBackupMetadata(stamp)[DESCRIPTION_KEY]).toBe(BACKUP_DESCRIPTION);
    expect(BACKUP_DESCRIPTION).toMatch(/Coin Inventory/);
  });

  it('keeps every key under the backup. prefix, so nothing else is shadowed', () => {
    // AppSettings is the Angular app's preference store. A backup stamp
    // that collided with a UI key would silently change a setting on
    // restore.
    for (const key of Object.keys(buildBackupMetadata(stamp))) {
      expect(key.startsWith('backup.')).toBe(true);
    }
  });
});

describe('readBackupProvenance', () => {
  it('round-trips what buildBackupMetadata wrote', () => {
    const metadata = buildBackupMetadata({
      takenAt: new Date('2026-11-14T15:04:05.000Z'),
      coinCount: 412,
      schemaVersion: 1,
    });

    expect(readBackupProvenance(metadata)).toEqual({
      takenAt: '2026-11-14T15:04:05.000Z',
      recordedCoinCount: 412,
    });
  });

  /* *** THE CASE THAT IS NOT AN ERROR. *** Every backup taken before this
   * feature existed carries no stamp. The dialog says "unknown", which is
   * the truth, and the restore goes ahead on the strength of the tables
   * and the pragma. */
  it('answers nulls for a backup with no stamp at all', () => {
    expect(readBackupProvenance({})).toEqual({ takenAt: null, recordedCoinCount: null });
  });

  it('answers null rather than a wrong date for nonsense', () => {
    const provenance = readBackupProvenance({
      [TAKEN_AT_KEY]: 'last Tuesday',
      [COIN_COUNT_KEY]: 'lots',
    });
    expect(provenance).toEqual({ takenAt: null, recordedCoinCount: null });
  });

  it('answers null for an empty string, not an epoch date', () => {
    expect(readBackupProvenance({ [TAKEN_AT_KEY]: '' }).takenAt).toBeNull();
  });

  it('rejects a negative or fractional coin count', () => {
    expect(readBackupProvenance({ [COIN_COUNT_KEY]: '-5' }).recordedCoinCount).toBeNull();
    expect(readBackupProvenance({ [COIN_COUNT_KEY]: '3.5' }).recordedCoinCount).toBeNull();
  });

  it('accepts a legitimate zero — an empty collection is still a collection', () => {
    expect(readBackupProvenance({ [COIN_COUNT_KEY]: '0' }).recordedCoinCount).toBe(0);
  });
});
