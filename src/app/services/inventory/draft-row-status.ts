import { MainCoinDetails, checkMainCoinDetails } from '../coin-completeness';
import { meetsServerCreateRules } from './coin-create-requirements';

 /*
 * Draft row status — "a coin you are still typing is not an error".
 *
 * ---- WHAT WENT WRONG ----
 * The owner added a coin, typed a Year, and got a RED ERROR TOAST telling him
 * it could not be saved because there was not enough data. He had not
 * finished typing. Nothing had gone wrong.
 *
 * The POST itself is already fixed: `canCreateCoin`
 * (coin-create-requirements.ts) refuses to send a request the server is
 * guaranteed to refuse, so the toast no longer fires. What is left is the
 * PRESENTATION, and it was wrong independently of the bug:
 *
 *   - The row's only signal was an "Unsaved" chip whose whole message lived
 *     in a `title` tooltip. A tooltip is a footnote. It cannot be the primary
 *     way a user finds out why their coin is not in the database — it needs a
 *     mouse, a pause, and the guess that hovering would say anything.
 *   - Nothing in the detail panel — the thing the user is actually typing
 *     into — said a word about it.
 *
 * ---- THE RULE THIS FILE FOLLOWS ----
 * SAY WHAT TO DO, NOT WHAT IS MISSING. "Needs a Denomination before it can be
 * saved" tells the user their next keystroke. "Not enough data" tells them
 * they have failed at something. The two sentences describe the same state.
 *
 * ---- WHAT IS STILL AN ERROR ----
 * A save that was ATTEMPTED AND REFUSED. That is a different event: the
 * server was asked and said no, which the user cannot fix by typing faster.
 * `CoinEditor.onDraftCreateFailed` keeps its red toast, and the `failed` flag
 * below is how the row and the panel keep saying so after the toast is gone.
 *
 * ---- WHY THE WORDING IS NOT CHANGED AT SOURCE ----
 * `describeMissingCoinDetail` (services/coin-completeness.ts) is SHARED with
 * the QIF importer, where its sentences land in the exceptions list of a real
 * import of the owner's Quicken files; and `describeMissingServerRequirement`
 * phrases the same facts for the tooltip that already exists. Neither is
 * touched. This module is a second, shorter reading of the SAME gate —
 * `canCreateCoin` — written for a place where the user can only spare a
 * glance.
 *
 * Everything here is pure. No Angular, no DOM, no signals.
  */

/** How a still-unsaved row should describe itself. */
export interface DraftRowStatus {
  /**
   * A few words, sized for a grid cell: "Needs Denomination".
   * Empty when there is nothing for the user to do.
   */
  readonly chip: string;
  /** One calm sentence for the detail panel, always populated. */
  readonly summary: string;
  /** True when a save was attempted and refused — the one genuine error. */
  readonly failed: boolean;
  /** True when the user has something to type before this row can save. */
  readonly needsInput: boolean;
}

export interface DraftRowStatusOptions {
  /**
   * What the draft registry says about this row's LAST CREATE ATTEMPT, i.e.
   * `InventoryService.draftHint(coin)`.
   *
   * Read only when the row already satisfies every save rule, because that
   * is the only state in which `describeWhatIsMissing` can be talking about
   * a failure rather than about a missing field (it returns the missing-field
   * sentences first — see CoinDraftRegistry.describeWhatIsMissing). Passing
   * the hint in, rather than reaching into the registry, keeps this module
   * pure and keeps the registry's three-case ordering in one place.
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
 * What an unsaved row should say about itself.
 *
 * The cases are in the order the user needs them, which is also the order
 * `CoinDraftRegistry.describeWhatIsMissing` uses:
 *
 *   1. The server refuses a coin with no denomination outright, so that is
 *      always the first thing to ask for — even when the 2-of-3 rule is
 *      already satisfied. This is the exact state the owner was in: a Year
 *      and a Coin Type typed, and a row that would never save.
 *   2. Short of the 2-of-3 rule: name the fields that would satisfy it.
 *   3. Nothing missing, but the last attempt was refused: that is an error,
 *      and it keeps saying so.
 *   4. Nothing missing and no failure: the create is on its way.
 */
export function describeDraftRow(
  coin: MainCoinDetails,
  options: DraftRowStatusOptions = {}
): DraftRowStatus {
  const detail = checkMainCoinDetails(coin);

  // 1. The server's own hard requirement.
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

  // 2. Still short of the 2-of-3 rule. Reachable with a denomination the
  //    server accepts but the completeness rule does not — "Other", "Unknown"
  //    and friends (see PLACEHOLDER_DETAIL_VALUES in coin-completeness.ts).
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

  // 3. Complete, but the server was asked and said no.
  const lastAttempt = (options.lastAttempt ?? '').trim();
  if (lastAttempt) {
    return { chip: 'Save failed', summary: lastAttempt, failed: true, needsInput: false };
  }

  // 4. Complete, and its create is queued or in flight.
  return { chip: '', summary: 'Saving this coin now.', failed: false, needsInput: false };
}
