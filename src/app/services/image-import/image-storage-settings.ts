/*
 * image-storage-settings.ts — the two photo settings, and what they mean.
 *
 * Storage mode:
 *   'stored'     (default) a downscaled copy is kept in the database, with the
 *                original's location recorded alongside.
 *   'referenced' only the location is kept; views read the file from disk via
 *                `GET /api/images/file?path=…`.
 * The stored copy is what survives the original being moved or deleted; a
 * referenced photo becomes a dead path. Changing the mode affects only future
 * imports; existing photos are not converted.
 *
 * Maximum size: `maxStoredImageBytes` limits the stored copy, not the user's
 * file (see encode-budget.ts). It has no effect in 'referenced' mode.
 *
 * Both live in the shared `StorageKeys.AppSettings` object, so writers must
 * read-modify-write to preserve other preferences.
 */

import { AppSettings, ImageStorageMode } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';

export type { ImageStorageMode };

/** Default: keep a downscaled copy in the database. */
export const DEFAULT_IMAGE_STORAGE_MODE: ImageStorageMode = 'stored';

/**
 * The default size budget: 1 MB per stored photo. A 1600 px / q0.85 JPEG
 * averages ~250 KB but tops out around 1 MB, so at this default the budget
 * never forces re-compression; it only applies when the user lowers it.
 */
export const DEFAULT_MAX_STORED_IMAGE_BYTES = 1024 * 1024;

/**
 * Upper limit: 10 MB. Enforced here too, since the value can come from a text
 * box or an older settings object.
 */
export const MAX_STORED_IMAGE_BYTES_CAP = 10 * 1024 * 1024;

/**
 * Lower limit: 64 KB. Below this even the smallest ladder rung (640 px)
 * can't fit, so every photo would be over budget.
 */
export const MIN_STORED_IMAGE_BYTES = 64 * 1024;

/** The pair, resolved — never partial, so callers need no fallbacks. */
export interface ImageStorageSettings {
  mode: ImageStorageMode;
  maxStoredImageBytes: number;
}

/** The settings as a fresh install has them. */
export const DEFAULT_IMAGE_STORAGE_SETTINGS: ImageStorageSettings = {
  mode: DEFAULT_IMAGE_STORAGE_MODE,
  maxStoredImageBytes: DEFAULT_MAX_STORED_IMAGE_BYTES
};

/**
 * Anything that is not exactly 'referenced' is 'stored', the mode that
 * cannot lose a photograph.
 */
export function normalizeImageStorageMode(value: unknown): ImageStorageMode {
  return value === 'referenced' ? 'referenced' : 'stored';
}

/**
 * Bring a saved or typed size budget into range. Unusable values become the
 * default, not the floor.
 */
export function clampMaxStoredImageBytes(value: unknown): number {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_MAX_STORED_IMAGE_BYTES;

  return Math.round(
    Math.min(MAX_STORED_IMAGE_BYTES_CAP, Math.max(MIN_STORED_IMAGE_BYTES, bytes))
  );
}

/** Pull both settings out of a (possibly ancient, possibly absent) blob. */
export function imageStorageSettingsFrom(settings: AppSettings | null | undefined): ImageStorageSettings {
  return {
    mode: normalizeImageStorageMode(settings?.imageStorageMode),
    maxStoredImageBytes: clampMaxStoredImageBytes(settings?.maxStoredImageBytes)
  };
}

/**
 * Read both settings. Best-effort: with no storage, or storage that throws,
 * the defaults are used.
 */
export async function loadImageStorageSettings(
  storage?: StorageService
): Promise<ImageStorageSettings> {
  if (!storage) return { ...DEFAULT_IMAGE_STORAGE_SETTINGS };

  try {
    return imageStorageSettingsFrom(await storage.get<AppSettings>(StorageKeys.AppSettings));
  } catch {
    return { ...DEFAULT_IMAGE_STORAGE_SETTINGS };
  }
}

/**
 * Persist both settings, leaving every other preference alone
 * (read-modify-write; the spread comes first so these values win).
 */
export async function saveImageStorageSettings(
  storage: StorageService,
  settings: ImageStorageSettings
): Promise<void> {
  const existing = (await storage.get<AppSettings>(StorageKeys.AppSettings)) ?? undefined;
  await storage.set<AppSettings>(StorageKeys.AppSettings, {
    ...(existing ?? { showTransactionsInDetails: false }),
    imageStorageMode: normalizeImageStorageMode(settings.mode),
    maxStoredImageBytes: clampMaxStoredImageBytes(settings.maxStoredImageBytes)
  });
}

/** "250 KB" / "1 MB" — for the Settings screen and the import summary. */
export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  const mb = bytes / (1024 * 1024);
  // One decimal unless it is a whole number of megabytes: "1 MB", "2.5 MB".
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
