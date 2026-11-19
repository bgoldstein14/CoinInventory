/*
 * Validation and messages for adding, editing and removing issuers.
 *
 * Rules map to the `Issuers` columns. Kind is not entered; it is derived from
 * the years (issuer-kind.ts), and the server's value is the one stored.
 *
 * - ISO code: exactly two letters or blank. CHAR(2) silently truncates or pads.
 * - Years may be negative (BC).
 * - Names must be unique (UQ_Issuers_Name; seeding also matches by name).
 */

import {
  ISSUER_KINDS,
  ISSUER_NAME_MAX_LENGTH,
  IssuerKind,
  NewIssuer,
} from '../../types/reference-data.model';
import { resolveIssuerKind } from './issuer-kind';

// Re-exported so callers of the validator don't need a second import.
export { ISSUER_KINDS, ISSUER_NAME_MAX_LENGTH };
export type { NewIssuer };

/**
 * The form's raw state, as the inputs give it. `lookUpOnline` is the user's
 * standing consent for the online denomination lookup, not an issuer field.
 */
export interface IssuerDraft {
  name: string;
  isoCode: string;
  validFrom: string;
  validTo: string;
  lookUpOnline: boolean;
}

export type IssuerDraftResult =
  | { ok: true; issuer: NewIssuer }
  | { ok: false; error: string };

/**
 * An empty form.
 *
 * @param lookUpOnline the previous checkbox value, carried across so clearing
 *   the form doesn't re-tick a box the user turned off.
 */
export function blankIssuerDraft(lookUpOnline = DEFAULT_LOOK_UP_ONLINE): IssuerDraft {
  return { name: '', isoCode: '', validFrom: '', validTo: '', lookUpOnline };
}

/** The lookup checkbox's default when the user has never answered it. */
export const DEFAULT_LOOK_UP_ONLINE = true;

/** Blank means "not stated", which is a legal value for every year column. */
function parseYear(raw: string, field: string): { ok: true; year: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, year: null };

  // A leading minus is allowed (BC); decimals are not (the column is INT).
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, error: `${field} must be a whole year, like 1821 or -27 for 27 BC.` };
  }

  return { ok: true, year: Number.parseInt(text, 10) };
}

/**
 * The kind this draft would be stored as, for display beside the year boxes.
 * The server derives the stored value with the same rule. Unparseable years
 * count as absent here; `validateIssuerDraft` rejects them on save.
 *
 * @param storedKind the row's current kind when editing; the server falls back
 *   to it when the years say nothing (e.g. British Colonial, no dates).
 */
export function previewIssuerKind(draft: IssuerDraft, storedKind: IssuerKind | null = null): IssuerKind {
  const from = parseYear(draft.validFrom, '');
  const to = parseYear(draft.validTo, '');
  return resolveIssuerKind(from.ok ? from.year : null, to.ok ? to.year : null, storedKind);
}

/**
 * Fill the form from an existing issuer, for editing. Years become strings to
 * match the inputs; `lookUpOnline` is false so editing never triggers a lookup.
 */
export function issuerDraftFrom(issuer: {
  name: string;
  isoCode: string | null;
  validFrom: number | null;
  validTo: number | null;
}): IssuerDraft {
  return {
    name: issuer.name,
    isoCode: issuer.isoCode ?? '',
    validFrom: issuer.validFrom === null ? '' : String(issuer.validFrom),
    validTo: issuer.validTo === null ? '' : String(issuer.validTo),
    lookUpOnline: false,
  };
}

/**
 * Validate the form, or return the first error found, in field order.
 *
 * @param existingNames every issuer name already present, in any case.
 */
export function validateIssuerDraft(
  draft: IssuerDraft,
  existingNames: readonly string[]
): IssuerDraftResult {
  const name = draft.name.trim();
  if (name.length === 0) {
    return { ok: false, error: 'An issuer needs a name — "Burma", "Papal States", "Parthia".' };
  }
  if (name.length > ISSUER_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `That name is ${name.length} characters; the limit is ${ISSUER_NAME_MAX_LENGTH}.`,
    };
  }

  const clash = existingNames.find((existing) => existing.trim().toLowerCase() === name.toLowerCase());
  if (clash !== undefined) {
    return { ok: false, error: `"${clash}" is already an issuer. Open it to add denominations to it.` };
  }

  const isoText = draft.isoCode.trim();
  // Exactly two letters, or absent.
  if (isoText.length > 0 && !/^[A-Za-z]{2}$/.test(isoText)) {
    return {
      ok: false,
      error: 'An ISO code is exactly two letters, like MX or GB. Leave it blank if there is not one.',
    };
  }

  const from = parseYear(draft.validFrom, 'The first year');
  if (!from.ok) return { ok: false, error: from.error };

  const to = parseYear(draft.validTo, 'The last year');
  if (!to.ok) return { ok: false, error: to.error };

  if (from.year !== null && to.year !== null && to.year < from.year) {
    return { ok: false, error: `The last year (${to.year}) is before the first (${from.year}).` };
  }

  return {
    ok: true,
    // No `kind`: the server derives it from the years.
    issuer: {
      name,
      isoCode: isoText.length > 0 ? isoText.toUpperCase() : null,
      validFrom: from.year,
      validTo: to.year,
    },
  };
}

/**
 * How serious removing an issuer is: 'routine' when no coin uses any of its
 * denominations, 'serious' when coins will lose their denomination link.
 */
export type IssuerRemovalSeverity = 'routine' | 'serious';

export interface IssuerRemovalPlan {
  severity: IssuerRemovalSeverity;
  denominationCount: number;
  coinCount: number;
  /** The exact text handed to the confirmation dialog. */
  message: string;
}

/** "3 denominations" / "1 denomination". */
function denominationsPhrase(count: number): string {
  return count === 1 ? '1 denomination' : `${count} denominations`;
}

/** The denomination half of the badge on an issuer row, in words. */
export function describeDenominationCount(count: number): string {
  const safe = sane(count);
  return safe === 0 ? 'No denominations' : denominationsPhrase(safe);
}

/** "3 coins" / "1 coin". */
function coinsPhrase(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/** Clamp a count to a whole, non-negative number. */
function sane(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * The confirmation for removing an issuer, which cascades to its
 * denominations. The message quotes the coin count; affected coins keep their
 * denomination text (only `DenominationId` is cleared) and read as Other.
 *
 * @param denominationCount active denominations filed under the issuer
 * @param coinCount coins using any of them
 */
export function describeIssuerRemoval(
  name: string,
  denominationCount: number,
  coinCount: number
): IssuerRemovalPlan {
  const denominations = sane(denominationCount);
  const coins = sane(coinCount);
  const severity: IssuerRemovalSeverity = coins > 0 ? 'serious' : 'routine';

  const plan = { severity, denominationCount: denominations, coinCount: coins };

  // Routine: nothing depends on it.
  if (coins === 0) {
    if (denominations === 0) {
      return { ...plan, message: `Remove the issuer "${name}"? It has no denominations and no coins use it.` };
    }
    return {
      ...plan,
      message:
        `Remove the issuer "${name}"?\n\n` +
        `Its ${denominationsPhrase(denominations)} ${denominations === 1 ? 'goes' : 'go'} with it. ` +
        `No coin uses ${denominations === 1 ? 'it' : 'any of them'}, so nothing else changes.`,
    };
  }

  // Serious: coins depend on it. The denomination count goes in the question
  // itself, since dialogs are often read no further.
  const subject =
    denominations === 0
      ? `the issuer "${name}"`
      : denominations === 1
        ? `the issuer "${name}" and its 1 denomination`
        : `the issuer "${name}" and all ${denominations} of its denominations`;

  return {
    ...plan,
    message:
      `Remove ${subject}?\n\n` +
      `${coinsPhrase(coins)} ${coins === 1 ? 'uses' : 'use'} ` +
      `${denominations === 1 ? 'it' : 'them'}. ` +
      `No coin is deleted. ${coins === 1 ? 'It keeps' : 'Each one keeps'} the denomination text ` +
      `already recorded against it and will read as Other until you re-select a denomination, ` +
      `which re-links ${coins === 1 ? 'it' : 'them'}.\n\n` +
      `This cannot be undone in one step.`,
  };
}

/**
 * The message when adding an issuer revived a soft-deleted one (same id,
 * denominations restored). Coins unlinked by the removal stay unlinked.
 *
 * @param denominationsRestored how many came back; zero has its own wording.
 */
export function describeIssuerRevived(name: string, denominationsRestored: number): string {
  const restored = sane(denominationsRestored);

  if (restored === 0) {
    return (
      `Restored the issuer "${name}" — it had been removed, not deleted, so it kept its place. ` +
      `It has no denominations yet.`
    );
  }

  return (
    `Restored "${name}" and ${restored === 1 ? 'its 1 denomination' : `all ${restored} of its denominations`}. ` +
    `${restored === 1 ? 'It was' : 'They were'} deactivated when "${name}" was removed, not deleted, ` +
    `so ${restored === 1 ? 'it came' : 'they came'} back with it. ` +
    `Any coin unlinked at the time still reads as Other until you re-select a denomination on it.`
  );
}

/**
 * Why the lookup was skipped for a revived issuer: it already has its
 * denominations, and duplicate labels would make coin matching ambiguous.
 */
export function describeLookupSkippedForRevival(name: string, denominationCount: number): string {
  const count = sane(denominationCount);
  return (
    `"${name}" came back with ${count === 1 ? 'its denomination' : `its ${count} denominations`}, ` +
    `so nothing was looked up online and nothing left this machine. ` +
    `Add any that are missing below.`
  );
}

/**
 * The message after removal, built from what the server reports it did (not
 * from the earlier plan). Tolerates a missing or malformed response.
 */
export function describeIssuerRemoved(
  name: string,
  outcome: { denominationsRemoved?: number; coinsUnlinked?: number } | null | undefined
): string {
  const denominations = sane(Number(outcome?.denominationsRemoved ?? 0));
  const coins = sane(Number(outcome?.coinsUnlinked ?? 0));

  if (denominations === 0) return `Removed the issuer "${name}".`;

  const head = `Removed "${name}" and its ${denominationsPhrase(denominations)}.`;
  if (coins === 0) return `${head} No coin was using ${denominations === 1 ? 'it' : 'them'}.`;

  return (
    `${head} ${coinsPhrase(coins)} ${coins === 1 ? 'now reads' : 'now read'} as Other and ` +
    `${coins === 1 ? 'keeps' : 'keep'} the denomination text already recorded.`
  );
}
