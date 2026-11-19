/**
 * Tests for the photo storage mode and stored-size budget: safe defaults,
 * the 10 MB cap, unreadable values falling back to 'stored', and writes that
 * merge into the shared settings object.
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
    expect(normalizeImageStorageMode(undefined)).toBe('stored');
    expect(imageStorageSettingsFrom(null).mode).toBe('stored');
    expect(imageStorageSettingsFrom({ showTransactionsInDetails: false }).mode).toBe('stored');
  });

  it('only ever reads an exact "referenced" as referenced', () => {
    expect(normalizeImageStorageMode('referenced')).toBe('referenced');

    // Anything else lands on the safe side.
    for (const junk of ['Referenced', 'reference', 'ref', 1, true, {}, null]) {
      expect(normalizeImageStorageMode(junk)).toBe('stored');
    }
  });
});

describe('the maximum stored size', () => {
  it('defaults to a budget the existing encoder never exceeds', () => {
    // A 1600 px / q0.85 encode tops out around 1 MB.
    expect(DEFAULT_MAX_STORED_IMAGE_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_MAX_STORED_IMAGE_BYTES).toBeLessThan(MAX_STORED_IMAGE_BYTES_CAP);
    expect(clampMaxStoredImageBytes(undefined)).toBe(DEFAULT_MAX_STORED_IMAGE_BYTES);
  });

  it('is capped at 10 MB', () => {
    // Very large base64 strings in JSON responses hit V8's string-length limit.
    expect(MAX_STORED_IMAGE_BYTES_CAP).toBe(10 * 1024 * 1024);
    expect(clampMaxStoredImageBytes(50 * 1024 * 1024)).toBe(MAX_STORED_IMAGE_BYTES_CAP);
    expect(clampMaxStoredImageBytes(Number.MAX_SAFE_INTEGER)).toBe(MAX_STORED_IMAGE_BYTES_CAP);
  });

  it('will not let the budget drop below what any photo can meet', () => {
    expect(clampMaxStoredImageBytes(1)).toBe(MIN_STORED_IMAGE_BYTES);
    expect(clampMaxStoredImageBytes(1024)).toBe(MIN_STORED_IMAGE_BYTES);
  });

  it('treats an unreadable value as the default, not as the floor', () => {
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

    // A second StorageService proves the values were persisted.
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
