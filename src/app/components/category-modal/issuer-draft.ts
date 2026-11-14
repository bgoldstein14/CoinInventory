/*
 * issuer-draft.ts — adding an issuer by hand.
 *
 * This form must not be able to produce a row the database will reject or,
 * worse, silently mangle. Every rule below maps to a column on `Issuers`:
 *
 *     Name       NVARCHAR(100) NOT NULL, CONSTRAINT UQ_Issuers_Name UNIQUE
 *     IsoCode    CHAR(2) NULL
 *     Kind       NVARCHAR(20) NOT NULL  -- 'modern'|'historical'|'ancient'
 *     ValidFrom  INT NULL
 *     ValidTo    INT NULL
 *
 * ...except Kind, WHICH THIS FORM NO LONGER ASKS FOR. It drives no
 * behaviour anywhere — it is stored and rendered as a tag — and the year
 * span already says it, so it is derived on save. The rule, the measurement
 * behind it and the one issuer it does not reproduce are in issuer-kind.ts.
 * `previewIssuerKind` below is only so the form can SHOW what will be
 * stored; the server recomputes it and the server's answer is the one that
 * lands in the column.
 *
 * THE THREE RULES THAT ARE NOT OBVIOUS
 *
 * 1. THE ISO CODE MUST BE EXACTLY TWO LETTERS OR NOTHING AT ALL.
 *    `CHAR(2)` is FIXED WIDTH. SQL Server truncates 'MMR' to 'MM' and pads
 *    'M' to 'M ' — both without an error, and neither visible afterwards.
 *    The padded one is the nastier of the two: it compares unequal to 'M'
 *    everywhere, so the issuer quietly stops matching anything.
 *
 * 2. YEARS MAY BE NEGATIVE.
 *    An obvious-looking "a year must be positive" rule excludes the Roman
 *    Republic (-509), which is a first-class citizen of this table rather
 *    than an afterthought. Negative means BC.
 *
 * 3. THE DUPLICATE CHECK IS NOT MERELY POLITENESS.
 *    `UQ_Issuers_Name` means the alternative is a 500 with a SQL
 *    constraint-violation message in it. Seeding also matches issuers BY
 *    NAME, so a second 'Mexico' makes that join multiply rows instead of
 *    failing — which is how a denomination gets deleted.
 *
 * Pure and DOM-free, so the rules are testable under Node without jsdom.
 */

import {
  ISSUER_KINDS,
  ISSUER_NAME_MAX_LENGTH,
  IssuerKind,
  NewIssuer,
} from '../../types/reference-data.model';
import { resolveIssuerKind } from './issuer-kind';

// Re-exported because they are this form's rules as much as the column's,
// and a caller that has imported the validator should not need a second
// import to render what it validates against.
export { ISSUER_KINDS, ISSUER_NAME_MAX_LENGTH };
export type { NewIssuer };

/**
 * The form's raw state: every field a string, as every <input> gives it.
 *
 * NO `kind`. There is no control for it any more — see the header.
 *
 * `lookUpOnline` is NOT about the issuer at all; it is the user's standing
 * answer to "may this app ask an outside service what denominations this
 * issuer struck". It lives on the draft because it is a field of the form,
 * and it is a boolean rather than a string because no <input> writes it as
 * text: a checkbox gives a boolean.
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
 * @param lookUpOnline the user's last answer to the online-lookup checkbox,
 *   carried across so that clearing the form after a save does not quietly
 *   re-tick a box they turned off. Defaults to ON, because the lookup is a
 *   feature that was asked for; a user who turns it off once means it, which
 *   is why the caller passes the previous value back in.
 */
export function blankIssuerDraft(lookUpOnline = DEFAULT_LOOK_UP_ONLINE): IssuerDraft {
  return { name: '', isoCode: '', validFrom: '', validTo: '', lookUpOnline };
}

/**
 * The checkbox's value on a machine that has never answered it.
 *
 * ON. The owner asked for the lookup, so refusing by default would ship a
 * feature switched off. It is one click to turn off and the choice is
 * remembered from then on.
 */
export const DEFAULT_LOOK_UP_ONLINE = true;

/** Blank means "not stated", which is a legal value for every year column. */
function parseYear(raw: string, field: string): { ok: true; year: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, year: null };

  // A leading minus is allowed (BC). A decimal point is not: ValidFrom is an
  // INT and 1870.5 would be rounded by the driver without saying so.
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, error: `${field} must be a whole year, like 1821 or -27 for 27 BC.` };
  }

  return { ok: true, year: Number.parseInt(text, 10) };
}

/**
 * The kind this draft would be stored as, for the tag beside the year boxes.
 *
 * DISPLAY ONLY. The server derives the same value from the same rule and its
 * answer is what reaches the column; this is here so the user can see the
 * consequence of typing a year before they press Add, which is the whole
 * reason dropping the picker is not just hiding a field.
 *
 * A year that does not parse is treated as absent rather than refused: the
 * user is mid-keystroke, and `validateIssuerDraft` is what refuses on save.
 */
export function previewIssuerKind(draft: IssuerDraft): IssuerKind {
  const from = parseYear(draft.validFrom, '');
  const to = parseYear(draft.validTo, '');
  return resolveIssuerKind(from.ok ? from.year : null, to.ok ? to.year : null);
}

/**
 * Validate the form, or explain in one sentence what is wrong with it.
 *
 * One error at a time, the first one found, in field order. A list of every
 * problem at once reads as a telling-off on a five-field form, and fixing
 * the first usually fixes the rest.
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
  // Exactly two letters, or absent. See rule 1 in the header.
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
    // No `kind`. The server derives it from these two years; see the
    // header and issuer-kind.ts.
    issuer: {
      name,
      isoCode: isoText.length > 0 ? isoText.toUpperCase() : null,
      validFrom: from.year,
      validTo: to.year,
    },
  };
}

/**
 * Whether an issuer can be removed, and what to say either way.
 *
 * REMOVAL IS BLOCKED WHILE DENOMINATIONS STILL POINT AT IT, which is the one
 * place this screen refuses rather than warns. The reason is that the
 * refusal is cheap and the alternative is not undoable in one step:
 * soft-deleting the issuer leaves its denominations pointing at a row the
 * API no longer returns, so every one of them silently falls into the "No
 * issuer yet" group, scattered through a list of over a thousand. Making the
 * user move or delete the denominations first keeps the decision explicit
 * and reversible at every step.
 *
 * `FK_Denominations_Issuer` would also stop a HARD delete, but the delete
 * here is soft, so the database will not catch this one for us.
 */
export function describeIssuerRemoval(
  name: string,
  denominationCount: number
): { allowed: boolean; message: string } {
  const count = Number.isFinite(denominationCount) && denominationCount > 0 ? Math.floor(denominationCount) : 0;

  if (count === 0) {
    return { allowed: true, message: `Remove the issuer "${name}"? It has no denominations.` };
  }

  const phrase = count === 1 ? '1 denomination' : `${count} denominations`;
  return {
    allowed: false,
    message:
      `"${name}" still has ${phrase} filed under it. ` +
      `Move or remove ${count === 1 ? 'it' : 'them'} first — otherwise ` +
      `${count === 1 ? 'it' : 'they'} would end up with no issuer at all.`,
  };
}
