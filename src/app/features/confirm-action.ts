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
 * treat "no confirm available" as "the user said yes" — exactly what the
 * original private helper inside App did.
 */
export function confirmAction(message: string): boolean {
  const confirmFn = typeof globalThis !== 'undefined' && 'confirm' in globalThis
    ? globalThis.confirm.bind(globalThis)
    : typeof window !== 'undefined' && 'confirm' in window
      ? window.confirm.bind(window)
      : null;

  if (!confirmFn) return true;
  return confirmFn(message);
}
