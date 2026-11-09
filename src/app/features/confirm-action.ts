/**
 * confirmAction() — a safe wrapper around the browser's `confirm()` dialog.
 *
 * WHY THIS FILE EXISTS
 * Two different places need "are you sure?" behaviour (deleting the selected
 * coin from the detail panel, and bulk-deleting from the bulk edit bar). Rather
 * than copy the defensive lookup into both, it lives here once.
 *
 * `window.confirm` is not available in every environment the app runs in
 * (unit tests without a DOM, server-side rendering). Instead of letting a
 * missing global crash a delete button, we look the function up defensively and
 * treat "no confirm available" as "the user said yes".
 */
export function confirmAction(message: string): boolean {
  const confirmFn = lookUpConfirm();

  if (!confirmFn) return true;
  return confirmFn(message);
}

/**
 * confirmOverwrite() — the same dialog, with the opposite default.
 *
 * WHY IT IS NOT JUST `confirmAction`
 * The shape fits perfectly: the coin editor's automatic metal / weight fill
 * (services/pm-autofill.ts) asks ONE yes-or-no question about a whole coin,
 * laying the conflicting fields out as lines of text, and a multi-line
 * `confirm()` renders that fine. There is no need for a bespoke modal to show
 * a four-row before/after table that the user answers with one word.
 *
 * What does NOT fit is `confirmAction`'s fail-OPEN default. "No confirm
 * available means yes" is right for the two callers it was written for, which
 * are both buttons the user pressed on purpose: refusing to delete a coin
 * because `window.confirm` was missing would leave them with a dead button
 * and no way forward.
 *
 * This caller is the reverse in both respects. NOBODY PRESSED ANYTHING — the
 * question is raised by the app itself, off the back of an edit to some other
 * field — and the "yes" branch overwrites a figure the user typed in by hand.
 * Failing open would mean: in any environment without `window.confirm`, this
 * feature silently replaces hand-entered data. That is precisely the bug the
 * prompt exists to prevent, so the default has to be the other way round.
 *
 * If the dialog cannot be shown, the answer is NO and nothing is written. The
 * user loses an automatic convenience, which they can still get from
 * Settings > Maintenance, and keeps their data.
 */
export function confirmOverwrite(message: string): boolean {
  const confirmFn = lookUpConfirm();

  if (!confirmFn) return false;
  return confirmFn(message);
}

/**
 * Find `confirm` wherever it lives, or report that it does not.
 *
 * Shared so the two functions above can never differ about WHERE they look —
 * only about what to do when the answer is "nowhere".
 */
function lookUpConfirm(): ((message: string) => boolean) | null {
  if (typeof globalThis !== 'undefined' && 'confirm' in globalThis) {
    return globalThis.confirm.bind(globalThis);
  }
  if (typeof window !== 'undefined' && 'confirm' in window) {
    return window.confirm.bind(window);
  }
  return null;
}
