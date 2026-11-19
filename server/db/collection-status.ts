/**
 * The values Coins.CollectionStatus (NVARCHAR(20) NOT NULL DEFAULT 'owned')
 * may hold: owned, wanted, ordered, for sale, sold.
 *
 * A copy of src/app/types/collection-status.ts, since the server project
 * can't import from src/. db/collection-status.spec.ts fails if they differ.
 * Adding or renaming a status means changing both lists and adding a migration.
 *
 * The server normalizes the value because the column is NOT NULL (an empty
 * value must become 'owned', not null) and the set is closed (it decides
 * whether a coin counts towards the collection's value).
 */

/** Every value Coins.CollectionStatus may hold, in the app's declared order. */
export const COLLECTION_STATUSES = [
  'owned',
  'wanted',
  'ordered',
  'for-sale',
  'sold',
] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/** The default status; migration 010 also stamped it on pre-existing rows. */
export const DEFAULT_COLLECTION_STATUS: CollectionStatus = 'owned';

/**
 * The column's declared width. Must match setup-database.sql and the
 * `collectionStatus` maxLength in coin-fields.ts.
 */
export const MAX_COLLECTION_STATUS_LENGTH = 20;

/**
 * Alternate spellings that map to a token. Only 'for-sale' needs any (it's
 * the only hyphenated one). Keys are lower-cased with whitespace collapsed.
 */
const STATUS_SYNONYMS: Readonly<Record<string, CollectionStatus>> = {
  'for sale': 'for-sale',
  forsale: 'for-sale',
};

/**
 * Converts any request value into one of the valid tokens; never returns
 * null or the caller's text. Used by COIN_FIELDS for INSERT and UPDATE and
 * by row-mappers.ts on read. Unrecognised values become 'owned' rather than
 * failing the save.
 */
export function normalizeCollectionStatus(value: unknown): CollectionStatus {
  if (typeof value !== 'string') return DEFAULT_COLLECTION_STATUS;

  const cleaned = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!cleaned) return DEFAULT_COLLECTION_STATUS;

  if ((COLLECTION_STATUSES as readonly string[]).includes(cleaned)) {
    return cleaned as CollectionStatus;
  }

  return STATUS_SYNONYMS[cleaned] ?? DEFAULT_COLLECTION_STATUS;
}
