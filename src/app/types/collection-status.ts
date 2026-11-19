/*
 * Collection status: where a coin sits in the collecting cycle (wanted,
 * ordered, owned, for sale, sold). A want-list entry is an ordinary CoinRecord
 * with a different status, not a separate type.
 *
 *   owned     In hand. The default for any coin with no status.
 *   wanted    On the want list; not in hand.
 *   ordered   Committed to but not yet delivered.
 *   for-sale  In hand and listed; still counts in totals.
 *   sold      Disposed of; kept rather than deleted to preserve its history.
 *
 * "Duplicate" is not a status: a duplicate can also be for sale.
 *
 * Status is never derived from `soldDate` / `soldPrice`; only the user
 * changes it.
 *
 * Imports nothing, so coin.model.ts can import from here without a cycle.
 */

/** All statuses, in dropdown order (default first, then along the cycle). */
export const COLLECTION_STATUSES = [
  'owned',
  'wanted',
  'ordered',
  'for-sale',
  'sold'
] as const;

/** One of the five tokens above. This is what the database column holds. */
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

/**
 * Status for coins with none recorded (older data, backups, unmigrated rows).
 * Must be 'owned' so those coins stay in the totals.
 */
export const DEFAULT_COLLECTION_STATUS: CollectionStatus = 'owned';

/** Display text. Change freely: the stored value is the token, not this. */
export const COLLECTION_STATUS_LABELS: Record<CollectionStatus, string> = {
  owned: 'Owned',
  wanted: 'Wanted',
  ordered: 'Ordered',
  'for-sale': 'For Sale',
  sold: 'Sold'
};

/**
 * Statuses meaning the coin is physically in the collection; the basis of the
 * money totals and insurance schedule. 'ordered' is excluded because it is
 * not yet in hand.
 */
const HELD_STATUSES: ReadonlySet<CollectionStatus> = new Set<CollectionStatus>([
  'owned',
  'for-sale'
]);

/** Ready-made `{ value, label }` pairs for a <select>, in declared order. */
export const COLLECTION_STATUS_OPTIONS: ReadonlyArray<{ value: CollectionStatus; label: string }> =
  COLLECTION_STATUSES.map(value => ({ value, label: COLLECTION_STATUS_LABELS[value] }));

/**
 * Hand-typed spellings of a token, e.g. "For Sale" in a user's spreadsheet.
 * Keys are lower-cased with whitespace collapsed.
 */
const STATUS_SYNONYMS: Readonly<Record<string, CollectionStatus>> = {
  'for sale': 'for-sale',
  forsale: 'for-sale'
};

/**
 * Convert any untrusted value (JSON backup, CSV cell, DB row) to a status.
 * Missing or unrecognised values become 'owned' rather than an error.
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

/** Minimal structural shape, so this module need not import CoinRecord. */
export interface CollectionStatusBearing {
  collectionStatus?: CollectionStatus;
}

/** Is this coin physically in the collection? Use this for every "what do I have" calculation. */
export function isHeldInCollection(coin: CollectionStatusBearing): boolean {
  return HELD_STATUSES.has(normalizeCollectionStatus(coin.collectionStatus));
}

/** The held coins, in original order, keeping the caller's element type. */
export function heldCoins<T extends CollectionStatusBearing>(coins: readonly T[]): T[] {
  return coins.filter(isHeldInCollection);
}

/**
 * Display label for a status. Never a dash: a missing status means Owned, not unknown.
 */
export function collectionStatusLabel(value: unknown): string {
  return COLLECTION_STATUS_LABELS[normalizeCollectionStatus(value)];
}
