/**
 * Tests for the two photograph settings: where imported pictures go, and how
 * big the stored copy may be.
 *
 * WHAT MATTERS HERE
 *
 *  - THE DEFAULTS ARE TODAY'S BEHAVIOUR. A fresh install, a settings object
 *    written by an older build, unreadable storage — all three must behave
 *    like the app did before either setting existed: pictures in the
 *    database, at a budget no 1600 px / q0.85 encode can exceed.
 *  - THE CAP IS 10 MB. The owner named it; a settings object that says
 *    otherwise (hand-edited, or written by a future build) must not get
 *    past this module.
 *  - UNREADABLE MEANS 'stored'. 'referenced' is the mode that keeps no copy
 *    of the user's photographs, so a corrupt value must never land there.
 *  - WRITING MERGES. StorageKeys.AppSettings is one shared object; a writer
 *    that replaces it deletes the base folder and the transactions
 *    preference.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppSettings } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';
import {
  clampMaxStoredImageBytes,
  describeBytes,
  DEFAULT_MAX_STORED_IMAGE_BYTES,
  imageStorageSettingsFrom,
  loadImageStorageSettings,
  MAX_STORED_IMAGE_BYTES_CAP,
  MIN_STORED_IMAGE_BYTES,
  normalizeImageStorageMode,
  saveImageStorageSettings
} from './image-storage-settings';

describe('the storage mode', () => {
  it('defaults to keeping the picture in the database', () => {
    // The app's long-standing behaviour, and the only mode in which moving
    // the photo folder cannot lose a picture.
    expect(normalizeImageStorageMode(undefined)).toBe('stored');
    expect(imageStorageSettingsFrom(null).mode).toBe('stored');
    expect(imageStorageSettingsFrom({ showTransactionsInDetails: false }).mode).toBe('stored');
  });

  it('only ever reads an exact "referenced" as referenced', () => {
    expect(normalizeImageStorageMode('referenced')).toBe('referenced');

    // Anything else lands on the safe side. A typo in a hand-edited settings
    // object must not silently import the next 300 photos as bare paths.
    for (const junk of ['Referenced', 'reference', 'ref', 1, true, {}, null]) {
      expect(normalizeImageStorageMode(junk)).toBe('stored');
    }
  });
});

describe('the maximum stored size', () => {
  it('defaults to a budget the existing encoder never exceeds', () => {
    /*
     * 1600 px at quality 0.85 averages ~250 KB and tops out around 1 MB, so
     * the default must be at least that or it would silently re-compress a
     * share of every import — which would NOT be "defaulting to today's
     * behaviour". It must also stay well under the cap.
     */
    expect(DEFAULT_MAX_STORED_IMAGE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_MAX_STORED_IMAGE_BYTES).toBeLessThan(MAX_STORED_IMAGE_BYTES_CAP);
    expect(clampMaxStoredImageBytes(undefined)).toBe(DEFAULT_MAX_STORED_IMAGE_BYTES);
  });

  it('is capped at 10 MB', () => {
    // THE OWNER'S NUMBER. A build that let 50 MB through would put a 50 MB
    // base64 string in a JSON response — the V8 string-length outage again.
    expect(MAX_STORED_IMAGE_BYTES_CAP).toBe(10 * 1024 * 1024);
    expect(clampMaxStoredImageBytes(50 * 1024 * 1024)).toBe(MAX_STORED_IMAGE_BYTES_CAP);
    expect(clampMaxStoredImageBytes(Number.MAX_SAFE_INTEGER)).toBe(MAX_STORED_IMAGE_BYTES_CAP);
  });

  it('will not let the budget drop below what any photo can meet', () => {
    expect(clampMaxStoredImageBytes(1)).toBe(MIN_STORED_IMAGE_BYTES);
    expect(clampMaxStoredImageBytes(1024)).toBe(MIN_STORED_IMAGE_BYTES);
  });

  it('treats an unreadable value as the default, not as the floor', () => {
    // "I cannot read this" must mean "behave as the app always has", not
    // "squeeze every photograph to 64 KB".
    for (const junk of [undefined, null, 'big', NaN, 0, -5, {}]) {
      expect(clampMaxStoredImageBytes(junk)).toBe(DEFAULT_MAX_STORED_IMAGE_BYTES);
    }
  });

  it('keeps a value the user actually chose', () => {
    expect(clampMaxStoredImageBytes(400 * 1024)).toBe(400 * 1024);
    expect(clampMaxStoredImageBytes(2.5 * 1024 * 1024)).toBe(2.5 * 1024 * 1024);
  });
});

describe('describeBytes', () => {
  it('spells the budget out the way the Settings screen shows it', () => {
    expect(describeBytes(250 * 1024)).toBe('250 KB');
    expect(describeBytes(1024 * 1024)).toBe('1 MB');
    expect(describeBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('persistence', () => {
  let storage: StorageService;

  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    storage = new StorageService();
  });

  it('comes back on the defaults when nothing has been saved', async () => {
    await expect(loadImageStorageSettings(storage)).resolves.toEqual({
      mode: 'stored',
      maxStoredImageBytes: DEFAULT_MAX_STORED_IMAGE_BYTES
    });
  });

  it('runs on the defaults when there is no storage at all', async () => {
    // Some unit tests build the import session without a StorageService.
    await expect(loadImageStorageSettings(undefined)).resolves.toEqual({
      mode: 'stored',
      maxStoredImageBytes: DEFAULT_MAX_STORED_IMAGE_BYTES
    });
  });

  it('persists both settings and reloads them', async () => {
    await saveImageStorageSettings(storage, {
      mode: 'referenced',
      maxStoredImageBytes: 300 * 1024
    });

    // A second StorageService, to prove the values really went to storage.
    await expect(loadImageStorageSettings(new StorageService())).resolves.toEqual({
      mode: 'referenced',
      maxStoredImageBytes: 300 * 1024
    });
  });

  it('clamps on the way out as well as on the way in', async () => {
    await saveImageStorageSettings(storage, {
      mode: 'stored',
      maxStoredImageBytes: 99 * 1024 * 1024
    });

    const saved = await storage.get<AppSettings>(StorageKeys.AppSettings);
    expect(saved?.maxStoredImageBytes).toBe(MAX_STORED_IMAGE_BYTES_CAP);
  });

  it('leaves the other preferences in the shared object alone', async () => {
    await storage.set<AppSettings>(StorageKeys.AppSettings, {
      showTransactionsInDetails: true,
      imageImportBaseFolder: 'C:\\Pics'
    });

    await saveImageStorageSettings(storage, {
      mode: 'referenced',
      maxStoredImageBytes: 500 * 1024
    });

    const settings = await storage.get<AppSettings>(StorageKeys.AppSettings);
    expect(settings?.showTransactionsInDetails).toBe(true);
    expect(settings?.imageImportBaseFolder).toBe('C:\\Pics');
    expect(settings?.imageStorageMode).toBe('referenced');
  });
});
