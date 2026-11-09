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

// Re-exported because they are this form's rules as much as the column's,
// and a caller that has imported the validator should not need a second
// import to render the picker it validates against.
export { ISSUER_KINDS, ISSUER_NAME_MAX_LENGTH };
export type { NewIssuer };

/** The form's raw state: every field a string, as every <input> gives it. */
export interface IssuerDraft {
  name: string;
  isoCode: string;
  kind: string;
  validFrom: string;
  validTo: string;
}

export type IssuerDraftResult =
  | { ok: true; issuer: NewIssuer }
  | { ok: false; error: string };

/**
 * An empty form.
 *
 * `kind` starts at 'modern' rather than '' so the picker always has a
 * selection: an unset <select> shows a blank first row that looks like a
 * missing option, and the user then has to notice and fix something the form
 * could simply have decided. 'modern' is right far more often than not.
 */
export function blankIssuerDraft(): IssuerDraft {
  return { name: '', isoCode: '', kind: 'modern', validFrom: '', validTo: '' };
}

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

function isIssuerKind(value: string): value is IssuerKind {
  return (ISSUER_KINDS as readonly string[]).includes(value);
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

  const kind = draft.kind.trim();
  if (!isIssuerKind(kind)) {
    return { ok: false, error: `"${kind}" is not a kind of issuer. Choose modern, historical or ancient.` };
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
    issuer: {
      name,
      isoCode: isoText.length > 0 ? isoText.toUpperCase() : null,
      kind,
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
