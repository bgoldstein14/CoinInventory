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
 *
 * @param storedKind the kind already on the row, when EDITING one. It is
 *   what the server will fall back to for an issuer whose year span says
 *   nothing, so the form has to fall back to the same thing or it shows a
 *   classification the save will not produce. `British Colonial` — no
 *   dates, curated as 'historical' — is the row that proves it: without
 *   this argument the edit form would read 'modern' beside a value the
 *   server is about to leave as 'historical'. Omitted when ADDING, because
 *   there is no row yet and the default is the honest answer.
 */
export function previewIssuerKind(draft: IssuerDraft, storedKind: IssuerKind | null = null): IssuerKind {
  const from = parseYear(draft.validFrom, '');
  const to = parseYear(draft.validTo, '');
  return resolveIssuerKind(from.ok ? from.year : null, to.ok ? to.year : null, storedKind);
}

/**
 * Fill the form from an issuer that already exists, for editing it.
 *
 * *** THE MISSING HALF OF THIS SCREEN. *** There was no way to rename an
 * issuer: the row offered Remove and nothing else, so a name typed in the
 * wrong case could only be got rid of, not corrected. `PUT /issuers/:id`
 * had existed the whole time and nothing called it. Everything else that
 * went wrong on this screen was somebody working around that.
 *
 * Years come back as strings because every <input> gives them as strings
 * and a number here would make the boxes disagree with the add form's.
 * `lookUpOnline` is false and stays false: it is the user's standing
 * answer to a question about an outgoing request, and editing an issuer
 * that already has its denominations must not fire one.
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
 * How serious removing this issuer is.
 *
 *   routine   no coin depends on any of its denominations. Housekeeping:
 *             a mistyped issuer added five minutes ago, a duplicate, a
 *             country the collection does not actually cover.
 *   serious   coins depend on it. Every one of them loses its denomination
 *             link the moment this goes through.
 *
 * TWO LEVELS, NOT ONE, and that is the point rather than a nicety. A dialog
 * that sounds the same for "this affects nothing" and "this affects 43 of
 * your coins" teaches the user to click through it, which means the warning
 * that matters is the one they have already learned to ignore.
 */
export type IssuerRemovalSeverity = 'routine' | 'serious';

export interface IssuerRemovalPlan {
  severity: IssuerRemovalSeverity;
  denominationCount: number;
  coinCount: number;
  /** The exact text handed to the confirmation dialog. */
  message: string;
}

/** "3 denominations" / "1 denomination" — the plural, got right once. */
function denominationsPhrase(count: number): string {
  return count === 1 ? '1 denomination' : `${count} denominations`;
}

/**
 * The denomination half of the badge on an issuer row.
 *
 * Words rather than a bare number for the same reason `describeUsage` uses
 * them: "0" beside an issuer is ambiguous, and this badge sits next to the
 * button that removes the row.
 */
export function describeDenominationCount(count: number): string {
  const safe = sane(count);
  return safe === 0 ? 'No denominations' : denominationsPhrase(safe);
}

/** "3 coins" / "1 coin". */
function coinsPhrase(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/** Clamp a count to a whole, non-negative number before it is spoken aloud. */
function sane(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * What removing an issuer will do, and the sentence that asks permission.
 *
 * *** THIS USED TO REFUSE, AND THE REFUSAL WAS THE BUG. ***
 * While any denomination was filed under the issuer this returned
 * `allowed: false` and the screen never reached the server. The argument was
 * that the user should move or remove the denominations first — which the
 * owner did, and the button went on refusing, because the count it was
 * reading was a cached number that nothing decremented. The refusal was also
 * standing in for a rename the screen did not offer, so the one person who
 * ever hit it was not trying to delete anything.
 *
 * The removal now CASCADES and this function's job is to make the
 * consequence impossible to miss before it does.
 *
 * WHAT A STRONG WARNING NEEDS, AND WHAT MERELY MAKES IT A SCARY ONE
 * A number. "Some of your coins use these" cannot be acted on: the honest
 * answer to it is always no, and the user is left with the mess they opened
 * the screen to clear up. So the coin count is quoted, it comes before the
 * reassurance — hearing "nothing is lost" first reads as a sales pitch — and
 * the reassurance is specific about what survives.
 *
 * *** THE "OTHER" IT PROMISES IS THE NULL LINK, NOT A STORED STRING. ***
 * The server clears `Coins.DenominationId` and never touches
 * `Coins.Denomination`, which is what lets this sentence promise that the
 * coin keeps what it says. Nothing here, and nothing the user agrees to
 * here, writes a sentinel into that column.
 *
 * @param denominationCount active denominations filed under the issuer
 * @param coinCount coins using any of them — the number the cascade touches
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

  // ----- ROUTINE: nothing depends on it -----
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

  // ----- SERIOUS: coins depend on it -----
  // The denomination count is in the QUESTION, not only in the body,
  // because a confirmation dialog is read title-first and often no
  // further. The zero case cannot arise from real data — no denominations
  // means no coins to use them — but it is written out rather than
  // interpolated into "all 0 of its denominations".
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
 * What to say when the issuer was not created but BROUGHT BACK.
 *
 * *** THIS IS THE MOMENT THE USER FINDS OUT WHETHER THEIR DATA RETURNED. ***
 * Removal is a soft delete, so re-adding a removed issuer revives the
 * original row — same id, denominations back with it. Doing that silently
 * is the failure mode even though the outcome is the good one: the user
 * pressed Add expecting a blank issuer, and what they got is their old one.
 * If nobody says so they will either not notice the denominations came back
 * and add them again by hand, or notice and not know whether to trust them.
 *
 * It says RESTORED rather than ADDED, in the first word, because that is
 * the fact that differs from what they expected. The count is quoted for
 * the same reason `describeIssuerRemoved` quotes one: a number can be
 * checked against the list, and "its denominations" cannot.
 *
 * *** THE COINS ARE MENTIONED, AND ONLY HONESTLY. *** The removal unlinked
 * them and reviving the LABELS does not re-link them — `Coins.DenominationId`
 * was set to NULL and nothing here puts it back. This sentence must
 * therefore not read as "everything is as it was". How many coins that was
 * is not knowable at this point, so it is described rather than counted.
 *
 * @param denominationsRestored how many came back with it; ZERO IS A REAL
 *   ANSWER and gets its own sentence, because "Restored Burma and its 0
 *   denominations" is the kind of thing that makes a user stop reading
 *   these messages.
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
 * Why the online lookup did not run for an issuer that was just revived.
 *
 * *** NOT RUNNING IT IS THE CORRECT BEHAVIOUR, NOT A DEGRADATION. *** The
 * issuer already has its denominations back, so the lookup would propose
 * labels it already holds; accepting one would put TWO rows with the same
 * label under one issuer, and a coin carrying that text then resolves as
 * ambiguous, which resolves to NULL. The lookup would cost a denomination
 * rather than add one.
 *
 * It repeats the "nothing left this machine" promise because that promise
 * is the entire content of the consent checkbox, and the one time the user
 * ticked the box and no request went out is exactly when they are owed it.
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
 * What to say AFTERWARDS, from what the server reports it actually did.
 *
 * Deliberately built from the response and not from the plan that was
 * confirmed. The two are normally the same number and the one time they are
 * not — an import that landed between the warning and the OK — the user is
 * owed the real one. Telling them "43 coins" because that is what the
 * dialog guessed, when 44 were unlinked, would make the one screen whose
 * job is to be trusted about numbers quietly wrong.
 *
 * Tolerates a missing or malformed body so a successful delete is never
 * reported as a failure on account of its receipt.
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
