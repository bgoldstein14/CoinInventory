 /*
 * pm-fill.ts — TURNING "WHAT IS IT MADE OF?" INTO FOUR COIN FIELDS
 *
 * WHY THIS FILE EXISTS
 *
 * `pm-reference.ts` answers one question: given a country, a denomination and
 * a year, what is the coin made of? It answers in its own shape (`CoinAlloy`).
 *
 * THREE quite different features need that answer written into a coin's five
 * alloy fields — Metal Content, Composition, PM %, PM Weight (g) and the
 * coin's gross Weight:
 *
 *     1. the QUICKEN IMPORT, which fills them in as each coin is created;
 *     2. the CSV IMPORT, which does the same for a row read out of a
 *        spreadsheet, filling only what the file itself did not supply; and
 *     3. the PM BACKFILL in Settings, which fills in the blanks on coins that
 *        were already in the database before the import learned how to do it.
 *
 * The mapping lives here, once, and all three callers import it. A second
 * hand-written copy is exactly how two of them would drift: someone adds a
 * sixth field, or changes which lookup is called, fixes one caller and not
 * the other, and from then on an imported coin and a backfilled coin
 * disagree about the same physical object.
 *
 * NOTHING IN THIS FILE DECIDES WHAT A COIN IS MADE OF.
 * Every alloy rule — and in particular every deliberate refusal to guess — is
 * still owned by `pm-reference.ts`. This file only reshapes that answer and
 * works out which fields are safe to write.
  */

import { CoinRecord } from '../types/coin.model';
import { lookupCoinAlloy } from './pm-reference';
// The COARSE fallback: "what metal is this?" answered on its own, without the
// much harder "exactly how much pure metal is in it?". It is only ever
// consulted when `lookupCoinAlloy` has already declined -- see `composePmFields`.
import { inferMetalContent } from './metal-inference';

/**
 * The five fields this file ever writes, in the order the UI shows them.
 *
 * Exported as a frozen list rather than left implicit because two separate
 * safety rules are expressed in terms of it:
 *
 *   * the backfill's update payload must contain ONLY these keys (this project
 *     has a history of whole-record writes blanking unrelated columns), and
 *   * the "is this coin already complete?" test must consider all five and no
 *     others.
 *
 * A test asserts that a backfill payload's `Object.keys()` is a subset of this
 * list, so adding a key here is a deliberate act with a visible consequence.
 *
 * ---- WHY `weight` IS ON THIS LIST ----
 * `weight` is the coin's whole weight, alloy included, and it belongs here
 * for the reason the other four do: it follows from country + denomination +
 * year. It is the one key on the list that is NOT about precious metal,
 * despite the name "PM_FIELD_KEYS", and it is governed by all the same rules:
 * never overwritten, never invented, never sent alongside anything else.
 *
 * *** UNITS: GRAMS ***
 * `CoinRecord.weight` counted TROY OUNCES until migration 008 and counts
 * GRAMS afterwards. `grossWeightGrams` in the reference table is grams, so
 * the value is copied straight across with no conversion. If you ever see a
 * conversion appear here, something has gone wrong.
 */
export const PM_FIELD_KEYS = [
  'metalContent',
  'composition',
  'pmPercent',
  'pmWeightGrams',
  'weight'
] as const satisfies readonly (keyof CoinRecord)[];

/** One of the five alloy / weight field names. */
export type PmFieldKey = (typeof PM_FIELD_KEYS)[number];

/**
 * The five alloy / weight fields in `CoinRecord`'s own vocabulary.
 *
 * Deliberately NOT the same type as `CoinAlloy` from pm-reference.ts, even
 * though they carry the same facts. `CoinAlloy.metal` is the reference table's
 * name for the thing; `CoinRecord.metalContent` is the database column's name.
 * Keeping the rename in exactly one place (`composePmFields` below) is the
 * whole point of this file.
 *
 * A field is `undefined` — never 0, never '' — when the reference table has
 * nothing to say about it. That distinction matters: a bronze cent genuinely
 * has no PM weight, and writing 0 would make `computeMeltValue` treat it as a
 * recorded fact rather than as an absence.
 *
 * ---- WHY ONLY `metalContent` IS REQUIRED ----
 * The facts are not always learned together. There are two sources:
 *
 *   * the REFERENCE TABLE (`lookupCoinAlloy`) answers all five at once; and
 *   * the COARSE METAL INFERENCE (`metal-inference.ts`) answers the metal ONLY
 *     — "a US $20 is gold" says nothing whatsoever about how many grams of
 *     gold are in this particular one, nor what the whole coin weighs.
 *
 * In the second case `composition`, `pmPercent`, `pmWeightGrams` and `weight`
 * are genuinely unknown and stay `undefined`. They are NOT filled with '' or
 * 0: a `pmWeightGrams` of 0 would be a lie that `computeMeltValue` would then
 * read as a recorded fact, and an empty composition would make the coin look
 * as though somebody had checked and found nothing.
 *
 * `metalContent` stays required because a result with no metal at all has
 * nothing to say and is returned as `null` instead.
 */
export interface CoinPmFields {
  /** Canonical Metal value for the editor's dropdown: 'Gold', 'Silver', 'Clad', ... */
  metalContent: string;
  /**
   * Free-text alloy description, e.g. '90% Gold, 10% Copper'.
   * Absent when the metal was inferred coarsely and the exact alloy is unknown.
   */
  composition?: string;
  /** Alloy fineness as a percentage (90 = 90% fine). Absent for base metal and for a coarse answer. */
  pmPercent?: number;
  /** PURE precious-metal weight in grams (NOT the coin's gross weight). Absent for base metal and for a coarse answer. */
  pmWeightGrams?: number;
  /**
   * The WHOLE COIN's weight in GRAMS — alloy included, the figure a scale
   * reads. This is `CoinRecord.weight`, which is a count of GRAMS from
   * migration 008 onward.
   *
   * PRESENT FOR BASE-METAL COINS TOO, unlike the two PM numbers above: a
   * 1983 cent has no melt value but it certainly weighs 2.50 g. Absent only
   * when the coarse fallback answered, or on the two reference rows that
   * span two planchet standards (the large cent and the half cent).
   */
  weight?: number;
}

/**
 * Everything beyond country / denomination / year that is worth reading when
 * working out what a coin is made of.
 *
 * It is a separate bag rather than three more positional parameters because
 * every one of these is optional, and `composePmFields(d, y, c, h, '', '')`
 * would be unreadable at the call site.
 *
 * NOTE WHAT IS NOT HERE: `category`. A coin filed under "Gold Coins" is a
 * statement about the owner's filing cabinet, not about the coin — see the
 * header of `metal-inference.ts`.
 */
export interface PmFillContext {
  /** Coin type / series: 'Saint-Gaudens', 'Gold Eagle', 'Morgan', ... */
  coinType?: string;
  /** Any alloy description already recorded on the coin. */
  composition?: string;
}

/**
 * THE ONE COMPOSITION. Ask what the coin is made of, and hand the answer back
 * in `CoinRecord`'s field names.
 *
 * Both the Quicken import and the Settings backfill call this and nothing
 * else, so the two can never disagree about which lookup is authoritative or
 * about which field gets which value.
 *
 * ---- TWO SOURCES, AND THE ORDER BETWEEN THEM NEVER CHANGES ----
 * 1. `lookupCoinAlloy` (pm-reference.ts) IS AUTHORITATIVE. When it finds a
 *    catalogued row, its answer is used exactly as given — all five fields,
 *    unchanged. Nothing below may override, adjust or second-guess it.
 *
 * 2. ONLY WHEN IT ANSWERS NOTHING does the coarse metal inference get a turn,
 *    and all it can supply is `metalContent`. `composition`, `pmPercent`,
 *    `pmWeightGrams` and `weight` are left `undefined`, because they are
 *    genuinely unknown: knowing that a US $20 is gold says nothing about how
 *    many grams of gold are in this particular one, nor what it weighs.
 *
 * WHY THE FALLBACK EXISTS AT ALL. The reference table covers specific US
 * issues well, so anything outside it — foreign gold, unusual face values,
 * types not yet tabulated — would otherwise import with every precious-metal
 * field blank, including the metal, even where the coin type makes the metal
 * obvious.
 *
 * The timidity is unchanged by that fallback. Both sources still answer
 * nothing for combinations that had two alloys in circulation at once (the
 * 1942 nickel, the 1982 cent, the 1971-78 Eisenhower dollar, a bare `$1` in
 * the gold-dollar era), because:
 *
 *     A WRONG METAL SILENTLY PRODUCES A CONFIDENTLY WRONG MELT VALUE.
 *     A BLANK FIELD IS VISIBLE AND THE USER CAN FIX IT.
 *
 * @param denomination Normalised denomination ('50¢', '$20', '100 Soles')
 * @param year Year string; ranges ('1920-1930') and overdates ('1862/1') are tolerated
 * @param country Country name ('United States', 'Great Britain', 'Peru')
 * @param metalHint The metal, when something OUTSIDE the year/denomination pair
 *   already settles it. The import passes what the security name said out loud
 *   ('1855 G$1'); the backfill passes the coin's existing Metal Content, which
 *   is the owner's own hand-entered statement. Either way it is evidence, not
 *   a guess — which is why it is allowed to break ties the table refuses to.
 * @param context Coin type and existing composition — the extra evidence the
 *   coarse fallback reads. Purely optional: omitting it only makes the
 *   fallback more likely to answer nothing, never more likely to be wrong.
 */
export function composePmFields(
  denomination: string,
  year: string,
  country: string,
  metalHint?: string,
  context?: PmFillContext
): CoinPmFields | null {
  // ----- SOURCE 1: the catalogued answer, used verbatim when there is one.
  const alloy = lookupCoinAlloy(denomination, year, country, metalHint);
  if (alloy) {
    return {
      metalContent: alloy.metal,
      composition: alloy.composition,
      pmPercent: alloy.pmPercent,
      pmWeightGrams: alloy.pmWeightGrams,
      // The ONE rename that happens in this file, and the reason it exists:
      // the reference table calls it `grossWeightGrams` (because it sits next
      // to `pmWeightGrams` and the two must not be confused), while a coin
      // record calls it plainly `weight`. Grams on both sides — no conversion.
      weight: alloy.grossWeightGrams
    };
  }

  // ----- SOURCE 2: the coarse, metal-only fallback.
  const metal = inferMetalContent({
    coinType: context?.coinType,
    denomination,
    year,
    country,
    composition: context?.composition,
    metalHint
  });
  if (!metal) return null;

  // Deliberately a ONE-KEY object. The other four stay absent rather than
  // being filled with '' or 0 — see the comment on `CoinPmFields`. In
  // particular there is NO weight here: "a US $20 is gold" is a statement
  // about the metal, and says nothing about the planchet.
  return { metalContent: metal };
}

/**
 * Is this field EMPTY — i.e. does the coin record say nothing at all about it?
 *
 * ---- WHY ZERO COUNTS AS A VALUE, NOT AS A BLANK ----
 * The backfill's governing rule is "only fill blanks, never overwrite", because
 * a figure already in the record may have been typed in by hand and a
 * hand-entered figure outranks an inferred one. A `pmWeightGrams` of 0 is a
 * number somebody or something put there; it is not an absence. So it is left
 * alone, exactly like a 24.06 would be.
 *
 * (Note the contrast with spot PRICES, where this app treats 0 as "no price" —
 * see `hasAnySpotPrice`. That is sound because gold does not trade at zero. A
 * coin's precious-metal weight genuinely can be zero, so the same shortcut is
 * not available here.)
 *
 * `NaN` is the one numeric exception: it is what a failed parse leaves behind
 * and it can only ever mean "nothing usable".
 */
export function isPmFieldBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

/** True when the coin already has a value in all five alloy / weight fields. */
export function hasAllPmFields(coin: Partial<CoinRecord>): boolean {
  return PM_FIELD_KEYS.every((key) => !isPmFieldBlank(coin[key]));
}

/** Knobs on `inferPmFields`. One knob, and it exists for exactly one caller. */
export interface InferPmOptions {
  /**
   * Should the coin's OWN `metalContent` be passed to the lookup as evidence?
   *
   * Defaults to `true`, which is what every bulk path wants: the stored metal
   * is normally the owner's own hand-typed statement, and it is the only thing
   * that can settle an 1855 "$1" (gold dollar or silver dollar — nothing else
   * in the record says which).
   *
   * The EDITOR's autofill sets it to `false` on its first attempt, and the
   * reason is specific. After the user changes the denomination from "$1" to
   * "$20", the metal still on the record says "Silver" — not because anyone
   * believes it, but because it is the PREVIOUS inference's own output. Fed
   * back in as a hint it matches no $20 row, the table declines, only the
   * coarse fallback answers, and the 26.73 g silver-dollar weight stays on a
   * double eagle. A stale output must not be allowed to veto its replacement.
   * See `planPmAutofill` in pm-autofill.ts, which falls back to the hinted
   * question when the hintless one answers nothing.
   */
  useRecordedMetalAsHint?: boolean;
}

/**
 * Ask "what is this coin made of?" using a COIN RECORD as the question.
 *
 * Turning a `CoinRecord` into `composePmFields`' five arguments — which
 * column is the hint, which columns are context, what to do with `undefined`
 * — is a decision that MUST come out the same way for every caller. There are
 * two: the Settings backfill and the editor's autofill, which asks the same
 * question the moment the user edits a key field. Two copies of this
 * marshalling would drift (add `variety` to the context, fix one caller, and
 * the same coin gets two answers depending on which screen asked).
 *
 * It decides NOTHING about what is written. That is `pmFieldsToFill`'s job
 * (blanks only) or `planPmAutofill`'s (blanks silently, differences by
 * consent). This function only asks the question.
 */
export function inferPmFields(
  coin: Partial<CoinRecord>,
  options?: InferPmOptions
): CoinPmFields | null {
  const useHint = options?.useRecordedMetalAsHint ?? true;
  const metalHint =
    useHint && typeof coin.metalContent === 'string' ? coin.metalContent.trim() : '';

  return composePmFields(
    coin.denomination ?? '',
    coin.year ?? '',
    coin.country ?? '',
    metalHint || undefined,
    // The coin's own Coin Type and Composition, which is the evidence the
    // coarse metal fallback reads when the reference table has no row. A coin
    // typed "Gold Eagle" or "Saint-Gaudens" names its metal in that field even
    // when nothing else in the record pins down the alloy.
    {
      coinType: coin.coinType,
      composition: typeof coin.composition === 'string' ? coin.composition : undefined
    }
  );
}

/**
 * Work out exactly which of the five fields may be written for one coin, and
 * with what.
 *
 * ---- THREE CALLERS, ONE RULE ----
 * The Settings backfill calls this for every coin already in the database.
 * The CSV import calls it for each freshly-mapped row, so that a spreadsheet
 * that only lists year / denomination / grade still produces a coin with its
 * metal and weight filled in. Both get the same guarantee, which is the only
 * reason it is safe to share: A VALUE THAT IS ALREADY THERE IS NEVER TOUCHED.
 * On the backfill path that "already there" value is whatever the owner typed
 * months ago; on the CSV path it is whatever his file said. Both outrank an
 * inference, and both are protected by the same line of code below.
 *
 * (The Quicken import is the third path, and it reaches the same inference by
 * calling `composePmFields` directly — a QIF security name carries no alloy
 * or weight of its own, so there is nothing there for a blanks-only rule to
 * protect and no reason to run the "is it blank?" test.)
 *
 * ---- THE THREE RULES, ALL ENFORCED HERE ----
 * 1. ONLY BLANKS ARE FILLED. A field that already holds anything is omitted
 *    from the result entirely, so it cannot be sent and cannot be overwritten.
 *
 * 2. PARTIALLY-FILLED COINS GET THEIR GAPS COMPLETED, not skipped. The five
 *    fields are independent statements, and a blank one is unambiguously "no
 *    information" — filling it destroys nothing. A "skip if partly filled"
 *    rule would refuse exactly the coins that need help most: melt value
 *    needs BOTH `metalContent` AND `pmWeightGrams`, so a coin where only the
 *    metal was ever typed in still shows a blank melt figure. A CSV row that
 *    names a weight and nothing else, or a coin whose metal was hand-typed
 *    years ago, is partial by construction — the normal case, not the
 *    exception.
 *
 * 3. NOTHING IS INVENTED. Where the inference itself has no value — the PM
 *    weight and PM % of a bronze cent, the gross weight of a large cent, or
 *    all four of composition / PM % / PM weight / weight when only the coarse
 *    metal fallback could answer — the key is simply absent from the result.
 *    The field stays blank, which is the truth. That is why `CoinPmFields`
 *    has four optional members and one required one: a PARTIAL answer is a
 *    legitimate answer.
 * ---- THE EXISTING METAL IS USED AS A HINT ----
 * When the coin already names a metal, that value is passed to the lookup as
 * `metalHint`. This is the backfill's only source of evidence beyond year and
 * denomination, and it is a good one: it is what the owner typed. It settles
 * two cases the table otherwise refuses outright —
 *
 *   * a `$1` dated 1849-1889, which is a 24 g silver dollar or a 1.5 g gold
 *     dollar depending on nothing visible in the record; and
 *   * a 1992-or-later dime/quarter, where the silver proof issue is
 *     indistinguishable by date from the ordinary clad one.
 *
 * — and it narrows nothing else, because for an unambiguous coin the hint just
 * agrees with the single row that already matched. If the stored metal matches
 * NO row (a typo, or a metal the table does not cover for that denomination),
 * the lookup answers null and the coin is left alone. That is the right
 * failure: disagreeing with the owner is not something this feature should do.
 *
 * @returns The fields to write, or an empty object when there is nothing to do
 *   — either because the coin is already complete, or because the reference
 *   table declined to answer.
 */
export function pmFieldsToFill(coin: Partial<CoinRecord>): Partial<CoinRecord> {
  // Nothing to do, and no reason to spend a lookup on it.
  if (hasAllPmFields(coin)) return {};

  // The stored metal IS passed as a hint here: on this path it is the owner's
  // own statement about a coin nobody has just re-described. See
  // `InferPmOptions.useRecordedMetalAsHint` for the one caller that differs.
  const inferred = inferPmFields(coin);

  // Neither the reference table nor the coarse metal inference would commit
  // (two alloys struck with that date, an unknown coin, no year to work from).
  // Deliberately no third guess: a blank is an honest dash.
  if (!inferred) return {};

  const updates: Partial<CoinRecord> = {};
  for (const key of PM_FIELD_KEYS) {
    // Rule 1: never touch a field that already holds something.
    if (!isPmFieldBlank(coin[key])) continue;
    // Rule 3: never invent a value the reference table does not have.
    const value = inferred[key];
    if (value === undefined) continue;
    // The cast is safe by construction: `CoinPmFields` names the same five
    // keys as `CoinRecord` with the same types. TypeScript cannot prove that
    // through an index into a union of key types.
    (updates as Record<string, unknown>)[key] = value;
  }

  return updates;
}
