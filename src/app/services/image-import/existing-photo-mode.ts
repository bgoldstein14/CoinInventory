 /*
 * What to do about matched coins that already have photos:
 *   'leave'   import only for coins with no photos yet (default; can neither
 *             delete nor duplicate)
 *   'replace' delete the coin's current photos, then store the new ones
 *   'add'     keep existing photos and add genuinely new files
 * already-attached.ts handles recognising files already on a coin.
 *
 * The question is shown only when a matched coin has photos. It is a mode
 * flag, not a rewrite of the tick boxes: the user's selections are kept
 * intact, 'replace' can't be expressed as selection anyway, and the counts
 * must stay the same whichever answer is chosen.
 *
 * Pure functions over plain data so tests run under Node.
  */

import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import { coinPhotoCount } from '../coin-photos';

export type ExistingPhotoMode = 'leave' | 'replace' | 'add';

/** 'leave': the only option that can neither delete nor duplicate. */
export const DEFAULT_EXISTING_PHOTO_MODE: ExistingPhotoMode = 'leave';

/** Every number the question on screen contains. */
export interface ExistingPhotoCounts {
  /** Distinct coins this import would write to. "...of these 112 coins". */
  matchedCoins: number;
  /** How many of those already have at least one photo. "38 of these...". */
  coinsWithPhotos: number;
  /** The rest. "Import only for the 74 coins with no photos yet." */
  coinsWithoutPhotos: number;
  /** Photos currently on those coins. "Their 94 current photos are deleted." */
  existingPhotos: number;
}

/**
 * "This row will be written when Save is pressed", before the mode is applied.
 * Same rule as attach-runner and batch-import-session; duplicated to avoid an
 * import of the session, and pinned by the wiring spec.
 */
function isAttachable(row: BatchImageRow): boolean {
  return row.selected && !!row.selectedCoinId && row.decision !== 'skipped';
}

/** The distinct coin ids this import would write to, in first-seen order. */
function targetCoinIds(rows: readonly BatchImageRow[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isAttachable(row)) continue;
    const id = row.selectedCoinId!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * How many photos a coin has now (0 if not found). Uses `coinPhotoCount`, not
 * `imagePaths.length`: the list endpoint doesn't include images, so the array
 * is usually absent and every coin would look empty.
 */
function photoCount(inventory: readonly CoinRecord[], coinId: string): number {
  return coinPhotoCount(inventory.find(c => c.id === coinId));
}

/** Coins this import would write to that already have photos. */
export function coinIdsWithExistingPhotos(
  rows: readonly BatchImageRow[],
  inventory: readonly CoinRecord[]
): string[] {
  return targetCoinIds(rows).filter(id => photoCount(inventory, id) > 0);
}

/**
 * Counts for the question, from the rows this import would write (not the
 * whole inventory), unfiltered by mode.
 */
export function countExistingPhotos(
  rows: readonly BatchImageRow[],
  inventory: readonly CoinRecord[]
): ExistingPhotoCounts {
  const ids = targetCoinIds(rows);

  let coinsWithPhotos = 0;
  let existingPhotos = 0;
  for (const id of ids) {
    const count = photoCount(inventory, id);
    if (count > 0) {
      coinsWithPhotos += 1;
      existingPhotos += count;
    }
  }

  return {
    matchedCoins: ids.length,
    coinsWithPhotos,
    coinsWithoutPhotos: ids.length - coinsWithPhotos,
    existingPhotos
  };
}

/**
 * The rows that will actually be written under a given mode. 'leave' drops
 * every row for a coin that already has photos (not read, not written).
 * 'replace' and 'add' write all attachable rows; what happens to existing
 * photos is handled in attach-runner.ts.
 */
export function rowsWrittenUnderMode(
  rows: readonly BatchImageRow[],
  inventory: readonly CoinRecord[],
  mode: ExistingPhotoMode
): BatchImageRow[] {
  const attachable = rows.filter(isAttachable);
  if (mode !== 'leave') return attachable;

  const skip = new Set(coinIdsWithExistingPhotos(rows, inventory));
  return attachable.filter(row => !skip.has(row.selectedCoinId!));
}

/**
 * Confirmation text shown before a 'replace' import deletes photos (the
 * originals may no longer exist). Includes the actual counts so the user
 * can see the scale rather than a generic "Are you sure?".
 */
export function replaceConfirmationMessage(counts: ExistingPhotoCounts): string {
  const photos = `${counts.existingPhotos} ${counts.existingPhotos === 1 ? 'photo' : 'photos'}`;
  const coins = `${counts.coinsWithPhotos} ${counts.coinsWithPhotos === 1 ? 'coin' : 'coins'}`;

  return (
    `Delete ${photos} from ${coins}?\n\n` +
    `You chose "Replace what they have", so the ${photos} currently on ` +
    `${counts.coinsWithPhotos === 1 ? 'that coin' : 'those coins'} will be ` +
    `deleted before the new ones are saved. This cannot be undone from inside ` +
    `the app, and the original files these copies came from may no longer ` +
    `exist on disk.\n\n` +
    `Press Cancel to go back and choose "Leave them alone" or "Keep both".`
  );
}
