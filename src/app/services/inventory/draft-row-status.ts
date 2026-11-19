import { MainCoinDetails, checkMainCoinDetails } from '../coin-completeness';
import { meetsServerCreateRules } from './coin-create-requirements';

 /*
  * How an unsaved (draft) row describes itself in the grid chip and detail panel.
  * A coin still being typed is not an error, so messages say what to do next
  * ("Needs a Denomination before it can be saved"), not what is wrong. Only a
  * save that was attempted and refused is an error (`failed`), which
  * `CoinEditor.onDraftCreateFailed` also toasts.
  *
  * A short reading of the same gate as `canCreateCoin`. `describeMissingCoinDetail`
  * (shared with the QIF importer) and `describeMissingServerRequirement` are
  * left as they are. Pure.
  */

/** How an unsaved row describes itself. */
export interface DraftRowStatus {
  /** A few words for a grid cell ("Needs Denomination"); empty when nothing to do. */
  readonly chip: string;
  /** One sentence for the detail panel; always set. */
  readonly summary: string;
  /** True when a save was attempted and refused (the one real error). */
  readonly failed: boolean;
  /** True when the user must type something before the row can save. */
  readonly needsInput: boolean;
}

export interface DraftRowStatusOptions {
  /**
   * The draft registry's hint about the last create attempt
   * (`InventoryService.draftHint(coin)`). Read only when the row satisfies every
   * save rule: only then can that hint be about a failure rather than a missing
   * field. Passed in to keep this module pure.
   */
  readonly lastAttempt?: string;
}

/** "Year" / "Year or Coin Type" — bare labels, for the chip. */
function orLabels(labels: readonly string[]): string {
  return labels.join(' or ');
}

/** "a Year" / "a Year or a Coin Type" — prose, for the sentence. */
function orPhrase(labels: readonly string[]): string {
  return labels.map(label => `a ${label}`).join(' or ');
}

/** "Year, Coin Type and Denomination" — prose, for the sentence. */
function andPhrase(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What an unsaved row says about itself, in the same order as
 * `CoinDraftRegistry.describeWhatIsMissing`:
 *   1. No denomination: the server refuses it outright, so ask for it first,
 *      even if 2-of-3 is already met.
 *   2. Short of 2-of-3: name the fields that would satisfy it.
 *   3. Complete, but the last attempt was refused: an error.
 *   4. Complete, no failure: the create is on its way.
 */
export function describeDraftRow(
  coin: MainCoinDetails,
  options: DraftRowStatusOptions = {}
): DraftRowStatus {
  const detail = checkMainCoinDetails(coin);

  // 1. The server's hard requirement.
  if (!meetsServerCreateRules(coin)) {
    const alsoNeedsOneMore = detail.present.length === 0;
    return {
      chip: 'Needs Denomination',
      summary: alsoNeedsOneMore
        ? 'Needs a Denomination, plus a Year or a Coin Type, before it can be saved.'
        : 'Needs a Denomination before it can be saved.',
      failed: false,
      needsInput: true
    };
  }

  // 2. Short of 2-of-3; reachable with a denomination the server accepts but the
  //    rule doesn't ("Other", "Unknown"; see PLACEHOLDER_DETAIL_VALUES).
  if (!detail.passes) {
    const stillNeeded = 2 - detail.present.length;
    if (stillNeeded === 1) {
      return {
        chip: `Needs ${orLabels(detail.missing)}`,
        summary: `Needs ${orPhrase(detail.missing)} before it can be saved.`,
        failed: false,
        needsInput: true
      };
    }
    return {
      chip: 'Needs 2 details',
      summary: `Needs two of ${andPhrase(detail.missing)} before it can be saved.`,
      failed: false,
      needsInput: true
    };
  }

  // 3. Complete, but the server refused.
  const lastAttempt = (options.lastAttempt ?? '').trim();
  if (lastAttempt) {
    return { chip: 'Save failed', summary: lastAttempt, failed: true, needsInput: false };
  }

  // 4. Complete; the create is queued or in flight.
  return { chip: '', summary: 'Saving this coin now.', failed: false, needsInput: false };
}
