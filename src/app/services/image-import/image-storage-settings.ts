/*
 * image-storage-settings.ts — the two photo settings, and what they mean.
 *
 * ================= 1. THE STORAGE MODE =================
 *
 * 'stored'     the picture is downscaled and kept in the database, with the
 *              original's location recorded alongside it. THE DEFAULT, and
 *              what the app has always done.
 * 'referenced' only the location is kept. The database does not carry the
 *              picture; every view of that photo reads the file off disk
 *              through `GET /api/images/file?path=…`.
 *
 * *** THIS IS A DATA DECISION, NOT A PERFORMANCE TOGGLE. ***
 * The downscaled copy is not a cache. Design §4.4 keeps originals as
 * references, so for a STORED photo the copy in the database is the only
 * thing that survives the user moving, renaming or deleting the original —
 * and §4.9 records that as the reason the copies are kept in the database at
 * all. A REFERENCED photo has no such safety net: move the folder and the
 * app has nothing but a dead path. That is the trade the user is being
 * offered (and it is the trade the Settings screen spells out), the payment
 * for it being a database that stays small and an import that does not read
 * a single byte.
 *
 * WHAT CHANGING THE MODE DOES TO PHOTOS ALREADY IMPORTED: NOTHING.
 * It applies to photos imported from now on. Pictures already in the
 * database stay there, referenced photos stay referenced, and nothing is
 * deleted, converted or re-read. Anything else would be destructive on a
 * radio button — switching to 'referenced' would have to throw away pictures
 * whose originals may no longer exist, and switching to 'stored' would have
 * to re-read gigabytes off the share without progress or cancellation.
 * Converting what already exists is the §4.9a backfill, a separate job that
 * is deliberately NOT built here.
 *
 * ================= 2. THE MAXIMUM SIZE =================
 *
 * `maxStoredImageBytes` is the size of the COPY THIS APP STORES, not of the
 * user's file. See encode-budget.ts for why it is enforced by re-encoding
 * rather than by rejecting anything, and why the default never bites.
 *
 * It has no effect at all in 'referenced' mode, because nothing is stored.
 *
 * ================= WHERE THESE LIVE =================
 *
 * In the existing `StorageKeys.AppSettings` object, NOT in a key of their
 * own: that object is already persisted and already shared by the Settings
 * modal and the import's base folder. Every writer therefore has to
 * READ-MODIFY-WRITE, exactly as import-base-folder.ts does — building a
 * fresh object here would silently delete the other writers' values.
 */

import { AppSettings, ImageStorageMode } from '../../features/app-settings';
import { StorageService, StorageKeys } from '../storage.service';

export type { ImageStorageMode };

/** What the app has always done: keep a downscaled copy in the database. */
export const DEFAULT_IMAGE_STORAGE_MODE: ImageStorageMode = 'stored';

/**
 * The default size budget: 1 MB per stored photo.
 *
 * WHY THIS NUMBER IS "TODAY'S BEHAVIOUR" RATHER THAN 250 KB.
 * The existing pipeline is capped in PIXELS, not bytes: 1600 px on the long
 * edge at quality 0.85, which *averages* about 250 KB. Average is not
 * maximum — a detailed 1600 px JPEG at that quality tops out around 1 MB —
 * so a 250 KB default would quietly re-compress a good share of every
 * import and would NOT be today's behaviour. 1 MB sits just above the
 * ceiling of what the existing encoder can produce, so at the default every
 * photo is stored exactly as it is stored today, and the setting only ever
 * does something when the user deliberately lowers it.
 */
export const DEFAULT_MAX_STORED_IMAGE_BYTES = 1024 * 1024;

/**
 * The cap the owner asked for: 10 MB. Not negotiable in the UI and enforced
 * here as well, because the number arrives from a text box and from a
 * settings object written by an older build.
 */
export const MAX_STORED_IMAGE_BYTES_CAP = 10 * 1024 * 1024;

/**
 * The floor: 64 KB. Below this a 640 px JPEG cannot be met either, so the
 * setting would stop meaning anything and every photo would be stored over
 * budget. Refusing the value is clearer than accepting one that cannot work.
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
 * Anything that is not exactly 'referenced' is 'stored'.
 *
 * Deliberately biased: 'stored' is the mode that cannot lose a photograph,
 * so a corrupt or unrecognised saved value must land there rather than
 * quietly importing the next 300 photos as bare paths.
 */
export function normalizeImageStorageMode(value: unknown): ImageStorageMode {
  return value === 'referenced' ? 'referenced' : 'stored';
}

/**
 * Bring a saved or typed size budget into range.
 *
 * Anything unusable — a string, NaN, undefined, a value from a build that
 * did not have this setting — becomes the default rather than the floor:
 * "I cannot read this" must mean "behave as the app always has", not
 * "squeeze every photo to 64 KB".
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
 * Read both settings.
 *
 * Best-effort like the rest of StorageService: with no storage, or a storage
 * that throws, the import runs on the defaults — which is the behaviour the
 * app had before this feature, and the safe end of both settings.
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
 * Persist both settings, leaving every other preference alone.
 *
 * READ-MODIFY-WRITE — see the header. The spread must come first so the two
 * values here win while the base folder and the transactions preference
 * survive.
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
