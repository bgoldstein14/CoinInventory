 /*
 * existing-photo-mode.ts — what to do about coins that already have photos.
 *
 * THE BUG THIS EXISTS TO FIX
 *
 * An append-only attach with no deduplication re-attaches every photo in a
 * folder a second time when that folder is imported again.
 * already-attached.ts fixes the mechanical half of that -- recognising a file
 * that is already on the coin. This file is the other half: the user's
 * INTENT, which the program cannot guess, because all three answers are
 * reasonable and two of them are irreversible in opposite directions.
 *
 * THE THREE ANSWERS, AND WHY THE DEFAULT IS THE ONE IT IS
 *
 *   'leave'   Import only for the coins with no photos yet. Writes nothing
 *             whatsoever to a coin that already has photos.
 *   'replace' Delete that coin's current photos, then store the new ones.
 *   'add'     Keep the existing photos and add the genuinely-new files.
 *
 * The default is 'leave', and the reasoning is one sentence: it is the only
 * one of the three that can neither delete nor duplicate. 'replace' destroys
 * photos the user may have no other copy of. 'add' is the behaviour that
 * produced the bug report. 'leave' can at worst do nothing, and doing nothing
 * is always recoverable — the user picks another option and imports again.
 *
 * The question is asked ONLY when at least one matched coin actually has
 * photos. A three-way choice in front of someone importing into an empty
 * inventory is a question with no meaning, and a screen that asks those
 * trains people to stop reading the ones that do.
 *
 * WHY THIS IS A MODE FLAG AND NOT A REWRITE OF THE TICK BOXES
 *
 * 'leave' could be expressed by unticking the affected rows through
 * selection-rules.ts, which would have the appeal of showing the user exactly
 * which rows are dropping out. It is not done that way, for three reasons:
 *
 *   1. It is LOSSY. The tick boxes are the user's own expression of intent
 *      across hundreds of rows ("keep only Obverse + Reverse", then a dozen
 *      hand unticks). Switching the radio to "Keep both" and back would have
 *      to restore that, and a restore that is even slightly wrong silently
 *      changes what gets written.
 *   2. 'replace' CANNOT be expressed as selection anyway — it deletes — so a
 *      real mode flag has to exist regardless. Two mechanisms for one concept
 *      is the arrangement most likely to drift apart, and the symptom of the
 *      drift would be writing the wrong thing.
 *   3. The counts have to be computed from the MODE-INDEPENDENT set of rows.
 *      "38 of these 112 coins already have photos" is a fact about the import,
 *      not about the current answer — if picking 'leave' unticked those rows,
 *      the sentence offering the choice would immediately rewrite itself to
 *      "0 of 74", and the user could never get back to it.
 *
 * What the user DOES get instead is honesty in the numbers: `rowsWrittenUnderMode`
 * below drives the Save button's count and the summary line, so the screen
 * always reports what will actually happen.
 *
 * Pure functions over plain data — no Angular, no HTTP — because the unit
 * tests run under Node with no DOM. Same pattern as base-folder-check.ts.
  */

import { BatchImageRow, CoinRecord } from '../../types/coin.model';
import { coinPhotoCount } from '../coin-photos';

/** The three answers. See the header for why each one exists. */
export type ExistingPhotoMode = 'leave' | 'replace' | 'add';

/**
 * 'leave' — the only option that can neither delete nor duplicate.
 *
 * Exported as a constant rather than written inline at the signal, so the
 * reasoning above has something to be attached to and a test can pin it.
 */
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
 *
 * The same rule `attach-runner.runAttach` applies and the same one
 * batch-import-session.ts states, repeated here rather than imported because
 * this module must stay free of the session. The two are pinned together by
 * the wiring spec.
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
 * How many photos a coin has right now. A coin we cannot find has none.
 *
 * THIS MUST NOT READ `imagePaths.length` ALONE. `GET /api/coins` no longer
 * carries image payloads (see server/routes/coins/list-query.ts), so on an
 * ordinary import — where the user has not opened any of the matched coins —
 * that array is absent on every single one of them. A length-only reading
 * would report the whole collection as having no photos, and three things
 * would quietly go wrong at once:
 *
 *   - the "38 of these coins already have photos" question would never be
 *     asked, so the user would never get to choose;
 *   - 'leave' (the default) would stop leaving anything alone; and
 *   - 'replace' would skip its confirmation prompt before deleting photos.
 *
 * `coinPhotoCount` reads the loaded array when there is one and the list's
 * `imageCount` otherwise, so it is right in both states.
 */
function photoCount(inventory: readonly CoinRecord[], coinId: string): number {
  return coinPhotoCount(inventory.find(c => c.id === coinId));
}

/**
 * The coins this import would write to that ALREADY have photos.
 *
 * This is the set the whole question is about: the ones 'leave' skips,
 * 'replace' empties, and 'add' appends to.
 */
export function coinIdsWithExistingPhotos(
  rows: readonly BatchImageRow[],
  inventory: readonly CoinRecord[]
): string[] {
  return targetCoinIds(rows).filter(id => photoCount(inventory, id) > 0);
}

/**
 * Every number in the question, computed from the rows THIS IMPORT WOULD
 * WRITE — not from the inventory as a whole.
 *
 * That distinction is the one mistake worth guarding against here. "Their 94
 * current photos are deleted first" has to mean the photos of the coins in
 * this run; counting the whole library would overstate the damage by an order
 * of magnitude and turn a warning the user needs into noise he learns to skip.
 *
 * Note it takes the rows UNFILTERED by mode. See reason 3 in the header.
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
 * The rows that will actually be written under a given mode.
 *
 * Under 'leave' a coin with photos is not touched AT ALL — not appended to,
 * not re-saved, not even read off the share. That is the point of the option:
 * the cheapest and safest possible answer to "I added four photos to a folder
 * of three hundred".
 *
 * 'replace' and 'add' both write every attachable row; what differs is what
 * happens to the coin's EXISTING photos, which is the attach runner's job
 * (see attach-runner.ts) and not expressible as a row filter.
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
 * The text of the confirmation shown before a 'replace' import writes.
 *
 * WHY THERE IS A CONFIRMATION AT ALL
 * 'replace' is the one option that destroys data. The photos it deletes are
 * downscaled copies the user may have no other version of — the originals can
 * have been moved, renamed or deleted off the share years ago, which is
 * exactly why SourcePath links go grey. An accidental click on a radio button
 * at the top of a long screen, followed by Save at the bottom of it, would be
 * silent and irreversible.
 *
 * WHY THE NUMBERS ARE IN THE MESSAGE
 * "Are you sure?" teaches people to press OK without reading. A sentence
 * containing "94 photos" and "38 coins" cannot be skimmed into meaning
 * nothing: if those numbers are bigger than the user expected, that IS the
 * warning, and no amount of prose would have delivered it as well.
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
