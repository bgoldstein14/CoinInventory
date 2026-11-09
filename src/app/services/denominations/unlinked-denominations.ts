 /*
 * unlinked-denominations.ts — "which coins have no denomination, and why"
 *
 * THE SITUATION THIS EXISTS FOR
 *
 * Migration 014 resolves every coin's `Coins.Denomination` text to a
 * `DenominationId` where it can, and prints every distinct value it could
 * not. *** THAT REPORT IS SQL OUTPUT, AND A PACKAGED USER NEVER SEES IT. ***
 * They will simply have coins reading `Other (8 Reales)` with no explanation,
 * no list of which ones, and no route to fixing them.
 *
 * This module is that report, in the application, as something you can act
 * on. It is also NOT a migration artefact, because the state it describes
 * keeps happening long after migration 014 has run:
 *
 *   - §4.4 nulls `DenominationId` on every coin using a denomination the
 *     user deletes. Those coins land here the moment the dialog closes.
 *   - An import next year can write text that resolves to nothing. That is
 *     a CORRECT outcome (§4.1), not an error, and this is where it surfaces.
 *   - A user who adds the missing issuer to the reference list has coins
 *     that would now link but are not linked yet. See 'resolvable' below.
 *
 * THE WHOLE POINT IS THE GROUP, NOT THE COIN
 *
 * A collection can easily hold four `8 Reales` coins that all want the same
 * answer. Four separate edits for one decision is the thing that makes people
 * abandon a cleanup half-finished, which leaves the data in a worse state
 * than never starting. So coins are grouped by the question they ask, and the
 * fix is applied to the group.
 *
 * The grouping key is the ALIAS KEY of the recorded text, not the text, so
 * `3CS` and `Three Cent Silver` are one decision rather than two. It is the
 * same `denominationKey` the editor, the importers and migration 014 use; a
 * second folding here would be a second vocabulary to keep in step.
 *
 * *** AND THE KEY CARRIES THE RESOLUTION, WHICH IS THE SAFETY PROPERTY. ***
 * 'Penny' is id 30 for a coin filed under Great Britain and id 31 for one
 * filed under Australia. Grouping on the text alone would put both in one
 * group, and one click would file the Australian penny under Great Britain —
 * silently, on the one screen whose purpose is to prevent exactly that.
 *
 * FOUR REASONS, AND WHY THERE IS A FOURTH
 *
 * `resolveDenomination` already returns the vocabulary (its `outcome`), and
 * this module re-labels it for a human rather than inventing its own:
 *
 *   'ambiguous'        several issuers struck something by this name, and
 *                      the coin's country picks none of them. Rule 3 of the
 *                      resolver answers null rather than guessing. The fix
 *                      is to say WHICH issuer — the candidates are known, so
 *                      they are offered as a shortlist.
 *   'unknown'          text was recorded and no row in the reference list
 *                      names it. The fix is to pick something else, or to
 *                      add the missing denomination to the list.
 *   'nothing-recorded' nothing usable was recorded at all. Pick outright.
 *   'resolvable'       *** THE FOURTH, AND IT IS NOT HYPOTHETICAL. *** The
 *                      resolver CAN place this coin; it simply is not linked
 *                      yet. That is what the user has produced when they
 *                      follow the 'unknown' advice and add the denomination
 *                      to the reference list: the group they were just
 *                      looking at would otherwise go on saying "nothing
 *                      matches", which would be a lie, with the answer
 *                      sitting one click away.
 *
 * `__OTHER__` IS "NOTHING RECORDED", NOT "UNKNOWN"
 *
 * A coin can hold the literal string `__OTHER__`: the editor's custom-option
 * sentinel, residue from a defect fixed in
 * components/coin-editor-form/custom-option-mode.ts. `denominationDisplay`
 * already renders such a coin as `—`.
 *
 * `resolveDenomination` cannot know that. It sees text, finds no row naming
 * it, and answers 'unknown'. If this screen repeated that verdict it would
 * tell the user "nothing in the reference list matches __OTHER__ — add it",
 * and a denomination named after a UI sentinel would enter the database for
 * good.
 *
 * So the question "is there anything recorded here?" is asked of
 * `denominationDisplay`, not of the resolver — by checking whether it
 * answers `NO_DENOMINATION`. That is deliberately indirect: the list of
 * strings that are not denominations lives in exactly one place, it is the
 * same rule the grid and the reports render by, and asking it this way means
 * this screen and the cell the user is looking at can never disagree about
 * whether a coin "has" a denomination.
 *
 * PLAN / RUN, LIKE pm-backfill.ts, AND FOR THE SAME REASON
 *
 * `planUnlinkedFix` is pure and returns the exact payload for each coin;
 * `runUnlinkedFix` writes precisely that and nothing else. The preview is
 * therefore not a separate estimate that might disagree with the run — it is
 * literally the same objects.
 *
 * Pure, DOM-free and dependency-light, so the whole of it runs under Node
 * without jsdom like every other piece of logic in this project.
  */

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import { denominationChoiceUpdates } from '../../components/coin-editor-form/country-denomination-link';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { NO_DENOMINATION, denominationDisplay } from './denomination-display';
import { denominationIndexFor, resolveIndexedDenomination, type DenominationIndex } from './denomination-index';

/** Why a coin has no denomination link. See the header for each one. */
export type UnlinkedReason = 'resolvable' | 'ambiguous' | 'unknown' | 'nothing-recorded';

/**
 * Display order, and it is a cleanup order rather than an alphabet.
 *
 * 'resolvable' first because it is the only group that needs no judgement at
 * all — one click and it is gone — and clearing it shrinks the screen before
 * the user has to think about anything. 'nothing-recorded' last because it
 * is the only one where the app can offer no candidate whatsoever, so it is
 * the slowest and the least rewarding.
 */
const REASON_RANK: Readonly<Record<UnlinkedReason, number>> = {
  resolvable: 0,
  ambiguous: 1,
  unknown: 2,
  'nothing-recorded': 3,
};

/** The heading for the group of coins with nothing usable recorded. */
export const NOTHING_RECORDED_HEADING = 'Nothing recorded';

/** One coin inside a group. */
export interface UnlinkedCoinRef {
  coinId: string;
  /**
   * A short, recognisable name for the row.
   *
   * *** DELIBERATELY DOES NOT INCLUDE THE DENOMINATION, *** unlike
   * `describeCoinForBackfill`. The group heading already states the recorded
   * text, so repeating it on every row is noise; the COUNTRY is what
   * distinguishes one row from another here, and it is the field the user
   * may need to correct.
   */
  label: string;
  /** `Coins.Denomination`, trimmed. Empty when nothing usable was recorded. */
  recordedText: string;
  /** `Coins.Country`, trimmed. The resolver's tie-breaker, so it is shown. */
  country: string;
}

/** One denomination the user could pick for a whole group. */
export interface UnlinkedChoice {
  denominationId: number;
  label: string;
  /** '' only for a row filed under no issuer at all. */
  issuerName: string;
}

/** A set of coins asking one question, with one answer to give. */
export interface UnlinkedGroup {
  /** Stable identity for `@for (... ; track group.key)`. */
  key: string;
  reason: UnlinkedReason;
  /** Distinct recorded spellings, sorted. EMPTY for 'nothing-recorded'. */
  recordedTexts: readonly string[];
  /** Distinct coin countries, sorted. Blank countries are omitted. */
  countries: readonly string[];
  /** What the group is called on screen. */
  heading: string;
  coins: readonly UnlinkedCoinRef[];
  coinCount: number;
  /**
   * What the app can offer without the user searching: every candidate for
   * an 'ambiguous' group, the single answer for a 'resolvable' one, and
   * nothing at all for the other two. Sorted by issuer, then label.
   */
  choices: readonly UnlinkedChoice[];
}

export interface UnlinkedCensus {
  /**
   * FALSE until `GET /api/denominations` has landed.
   *
   * THE BUG THIS PREVENTS: with an empty lookup every coin fails to resolve,
   * so a census that did not know the difference would report the ENTIRE
   * collection as unlinked for the second or so between start-up and the
   * lookup arriving — a banner that screams on every launch and a pane that
   * is wrong for anyone who opens it quickly.
   */
  lookupLoaded: boolean;
  /** Coins looked at, drafts included. The denominator of the zero state. */
  totalCoins: number;
  /** Coins in `groups`. Zero is a real and useful answer. */
  unlinkedCount: number;
  groups: readonly UnlinkedGroup[];
  /** Always all four keys, zeros included, so a reader cannot miss one. */
  countsByReason: Readonly<Record<UnlinkedReason, number>>;
  /**
   * Rows that exist only on screen and have never been written to the
   * database. There is nothing to PUT, and they are coins the user is typing
   * right now rather than cleanup candidates.
   */
  skippedDraftCount: number;
}

 /*
 * THE CENSUS
  */

/** The issuer name the index reconstructed for a candidate row. */
function issuerNameFor(index: DenominationIndex, aliasKey: string, denominationId: number): string {
  const bucket = index.byAliasKey.get(aliasKey);
  if (!bucket) return '';

  const candidate = bucket.candidates.find((row) => row.denominationId === denominationId);
  if (!candidate || candidate.issuerId === null) return '';

  return bucket.issuers.find((issuer) => issuer.issuerId === candidate.issuerId)?.name ?? '';
}

/**
 * Turn a list of candidate ids into pickable choices.
 *
 * Everything comes out of the index's own bucket — the labels AND the issuer
 * names — rather than being re-derived here. `Denominations.Country` holds
 * 'MX' for Mexico and 'Roman Empire' for the Roman Empire, and the rule for
 * turning that back into an issuer is subtle enough that a second copy of it
 * once cost 52 coins their link (see denomination-index.ts). There is one
 * copy, and this reads it.
 */
function choicesFor(
  index: DenominationIndex,
  aliasKey: string,
  candidateIds: readonly number[]
): UnlinkedChoice[] {
  const bucket = index.byAliasKey.get(aliasKey);
  if (!bucket) return [];

  const choices: UnlinkedChoice[] = [];
  for (const denominationId of candidateIds) {
    const candidate = bucket.candidates.find((row) => row.denominationId === denominationId);
    if (!candidate) continue;
    choices.push({
      denominationId,
      label: candidate.label,
      issuerName: issuerNameFor(index, aliasKey, denominationId),
    });
  }

  return choices.sort(
    (left, right) =>
      left.issuerName.localeCompare(right.issuerName) || left.label.localeCompare(right.label)
  );
}

/**
 * A short name for one row of a group.
 *
 * Falls back to the coin id so a record with nothing in it at all is still
 * identifiable in a failure list.
 */
function describeUnlinkedCoin(coin: CoinRecord): string {
  const label = [coin.year, coin.mintMark, coin.coinType, coin.country]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return label || `coin ${coin.id}`;
}

interface GroupAccumulator {
  key: string;
  reason: UnlinkedReason;
  aliasKey: string;
  candidateIds: readonly number[];
  texts: Set<string>;
  countries: Set<string>;
  coins: UnlinkedCoinRef[];
}

/**
 * Which coins have no denomination link, grouped by the question they ask.
 *
 * @param coins the inventory exactly as the user sees it
 * @param denominations the lookup, straight from the denominations signal.
 *   An EMPTY list means "not loaded yet" and produces an empty census — see
 *   `lookupLoaded`.
 * @param isDraft tells us whether a row has ever reached the database.
 *   Passed in rather than imported so this stays pure, exactly as
 *   `planPmBackfill` does it.
 */
export function censusUnlinkedDenominations(
  coins: readonly CoinRecord[],
  denominations: readonly Denomination[],
  isDraft: (coinId: string) => boolean = () => false
): UnlinkedCensus {
  const countsByReason: Record<UnlinkedReason, number> = {
    resolvable: 0,
    ambiguous: 0,
    unknown: 0,
    'nothing-recorded': 0,
  };

  if (denominations.length === 0) {
    return {
      lookupLoaded: false,
      totalCoins: coins.length,
      unlinkedCount: 0,
      groups: [],
      countsByReason,
      skippedDraftCount: 0,
    };
  }

  const index = denominationIndexFor(denominations);
  const accumulators = new Map<string, GroupAccumulator>();
  let skippedDraftCount = 0;
  let unlinkedCount = 0;

  for (const coin of coins) {
    if (isDraft(coin.id)) {
      skippedDraftCount += 1;
      continue;
    }

    /* ALREADY LINKED? The question is asked of the ACTIVE rows, not of the
     * id. A coin pointing at a soft-deleted denomination renders
     * `Other (...)` exactly like an unlinked one, so by the screen's own
     * contract — "every coin that does not show a real denomination" — it
     * belongs here. §4.4 nulls the id and so should never produce this, but
     * "should never" is not "cannot", and the recoverable direction is to
     * show one coin too many rather than to hide one. */
    if (coin.denominationId != null && index.activeById.has(coin.denominationId)) continue;

    const recordedText = String(coin.denomination ?? '').trim();
    const country = String(coin.country ?? '').trim();

    /* IS ANYTHING RECORDED? Asked of the DISPLAY rule, not of the resolver.
     * See the header: `__OTHER__` is text to the resolver and a blank cell
     * to the user, and the user is right. */
    const hasText = denominationDisplay(null, recordedText) !== NO_DENOMINATION;

    let reason: UnlinkedReason;
    let aliasKey = '';
    let candidateIds: readonly number[] = [];
    let resolvedId: number | null = null;

    if (!hasText) {
      // One group for every coin with nothing usable recorded, whatever the
      // exact residue was. They are one problem with one fix.
      reason = 'nothing-recorded';
    } else {
      aliasKey = denominationKey(recordedText);
      const match = resolveIndexedDenomination(recordedText, country, index);
      candidateIds = match.candidateIds;

      switch (match.outcome) {
        case 'in-country':
        case 'any-issuer':
          reason = 'resolvable';
          resolvedId = match.denominationId;
          candidateIds = resolvedId === null ? [] : [resolvedId];
          break;
        case 'ambiguous':
          reason = 'ambiguous';
          break;
        case 'unknown':
          reason = 'unknown';
          break;
        default:
          /* 'empty'. Unreachable: `hasText` is true, so the text was neither
           * blank nor a sentinel, and the resolver only answers 'empty' for
           * text that folds away to nothing. Kept so that a future change to
           * the folding cannot route a coin into a reason that does not
           * exist, which would throw off the switch below. */
          reason = 'nothing-recorded';
          aliasKey = '';
          candidateIds = [];
          break;
      }
    }

    /* THE KEY CARRIES THE RESOLVED ID. See the header: two coins reading
     * 'Penny' under different countries resolve to different rows and must
     * never share a bulk action. */
    const key = `${reason}\u0000${aliasKey}\u0000${resolvedId ?? ''}`;

    let group = accumulators.get(key);
    if (!group) {
      group = {
        key,
        reason,
        aliasKey,
        candidateIds,
        texts: new Set<string>(),
        countries: new Set<string>(),
        coins: [],
      };
      accumulators.set(key, group);
    }

    if (reason !== 'nothing-recorded') group.texts.add(recordedText);
    if (country) group.countries.add(country);
    group.coins.push({
      coinId: coin.id,
      label: describeUnlinkedCoin(coin),
      recordedText: reason === 'nothing-recorded' ? '' : recordedText,
      country,
    });

    countsByReason[reason] += 1;
    unlinkedCount += 1;
  }

  const groups: UnlinkedGroup[] = [...accumulators.values()].map((group) => {
    const recordedTexts = [...group.texts].sort((left, right) => left.localeCompare(right));
    return {
      key: group.key,
      reason: group.reason,
      recordedTexts,
      countries: [...group.countries].sort((left, right) => left.localeCompare(right)),
      heading: recordedTexts.length > 0 ? recordedTexts.join(' / ') : NOTHING_RECORDED_HEADING,
      coins: group.coins,
      coinCount: group.coins.length,
      choices: choicesFor(index, group.aliasKey, group.candidateIds),
    };
  });

  /* Cheapest fixes first, then the biggest wins, then alphabetically — and
   * finally by key, which is the only tie-break that is guaranteed unique.
   * Without that last one two groups with the same heading (two 'Penny'
   * groups resolving to different issuers) would come out in whatever order
   * the Map happened to hold them, and a test of the order would pass or
   * fail on insertion order rather than on the rule. */
  groups.sort(
    (left, right) =>
      REASON_RANK[left.reason] - REASON_RANK[right.reason] ||
      right.coinCount - left.coinCount ||
      left.heading.localeCompare(right.heading) ||
      left.key.localeCompare(right.key)
  );

  return {
    lookupLoaded: true,
    totalCoins: coins.length,
    unlinkedCount,
    groups,
    countsByReason,
    skippedDraftCount,
  };
}

/**
 * The count, in a sentence — INCLUDING WHEN IT IS ZERO.
 *
 * "Every coin has a denomination" is a useful thing to be told, and a screen
 * that renders nothing is indistinguishable from a screen that is broken.
 * The denominator is included so the reassurance is checkable: "0 of 0"
 * would otherwise read identically to "0 of 105".
 *
 * Returns '' before the lookup has arrived, because at that point the app
 * genuinely does not know and must not say anything.
 */
export function describeUnlinkedCensus(census: UnlinkedCensus): string {
  if (!census.lookupLoaded) return '';

  if (census.unlinkedCount === 0) {
    const coins = census.totalCoins === 1 ? '1 coin' : `${census.totalCoins} coins`;
    return `Every coin has a denomination. ${coins} checked.`;
  }

  if (census.unlinkedCount === 1) return '1 coin has no denomination linked.';

  return (
    `${census.unlinkedCount} coins have no denomination linked, ` +
    `in ${census.groups.length} ${census.groups.length === 1 ? 'group' : 'groups'}.`
  );
}

/**
 * What is wrong with this group, said to a collector rather than to a
 * programmer.
 *
 * 'ambiguous' and 'any-issuer' are the RESOLVER'S words. They are the right
 * words inside the code and they are jargon in front of somebody who just
 * wants their coin to say "8 Reales" instead of "Other (8 Reales)". Each
 * sentence also names the fix, because a diagnosis with no next step is the
 * exact failure this whole screen exists to correct: migration 014's report
 * says what is wrong and offers nowhere to go.
 */
export function describeUnlinkedReason(reason: UnlinkedReason): string {
  switch (reason) {
    case 'resolvable':
      return 'These match a denomination in your list but are not linked to it yet. One press fixes them.';
    case 'ambiguous':
      return 'Several issuers struck a coin by this name, so the app will not guess which. Choose the issuer.';
    case 'unknown':
      return 'Nothing in your denomination list is called this. Pick something else, or add it to the list.';
    case 'nothing-recorded':
      return 'No denomination was ever recorded for these coins. Pick one.';
  }
}

/* ===========================================================================
 * THE FIX
 * =========================================================================== */

/**
 * The ONLY three columns this feature may write.
 *
 * Exported so the test that asserts "the payload contains nothing else" can
 * name the same list the code enforces — the arrangement pm-backfill.ts uses,
 * for the same reason: this project has a history of wide writes blanking
 * columns the user never touched, and this is a BULK writer.
 */
export const UNLINKED_FIX_FIELDS = ['denomination', 'denominationId', 'country'] as const;

/** Strip a payload down to the three fields above. Pure, justified paranoia. */
export function onlyUnlinkedFixFields(updates: Partial<CoinRecord>): Partial<CoinRecord> {
  const allowed = new Set<string>(UNLINKED_FIX_FIELDS);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.has(key)) clean[key] = value;
  }
  return clean as Partial<CoinRecord>;
}

/** One coin the fix intends to write, and exactly what it will send. */
export interface UnlinkedFixCandidate {
  coinId: string;
  label: string;
  updates: Partial<CoinRecord>;
}

export interface UnlinkedFixPlan {
  /** The chosen row, or null when the plan refused. */
  denominationId: number | null;
  /** The chosen row's Label — what will be written as text. '' when refused. */
  denominationLabel: string;
  /** The chosen row's issuer, for the confirmation sentence. */
  issuerName: string;
  candidates: readonly UnlinkedFixCandidate[];
  /** How many of those payloads also rewrite `Coins.Country`. */
  countryWrites: number;
  /**
   * Why there is nothing to do, or '' when there is. A refusal is a normal
   * state of this object (nothing picked yet), not an error.
   */
  refusal: string;
}

export interface UnlinkedFixOutcome {
  attempted: number;
  linked: number;
  failed: number;
  failures: { coinId: string; label: string; reason: string }[];
}

/**
 * What linking a whole group to one denomination would write.
 *
 * ---------------------------------------------------------------------------
 * IT GOES THROUGH THE EDITOR'S OWN PATH. THAT IS THE SAFETY RULE.
 * ---------------------------------------------------------------------------
 * `denominationChoiceUpdates` is what runs when the user picks a
 * denomination in the coin editor: it writes the LABEL as the text, and it
 * writes the Country only when the coin has none and exactly one issuer
 * could be meant. Both of those rules were reported bugs once. Restating
 * them here would be a second copy that drifts; calling it means a coin
 * fixed from this screen and the same coin fixed in the editor end up
 * byte-identical.
 *
 * *** THE TEXT WRITTEN IS THE CHOSEN ROW'S LABEL, NEVER THE COIN'S OWN. ***
 * Design §4.1 permits `Coins.Denomination` to be written with one thing
 * only: a label the user explicitly chose. A coin reading 'Three Cent
 * Silver' that is linked to '3¢ Silver' comes out saying '3¢ Silver',
 * because from a deliberate action onwards the two fields must agree.
 *
 * ---------------------------------------------------------------------------
 * `setCountry` IS OPT-IN AND WILL NEVER BE DEFAULTED
 * ---------------------------------------------------------------------------
 * A QIF-imported coin can be Mexican and say 'United States', because the
 * QIF parser never set a country. Picking Mexico's row links it correctly but
 * leaves that field wrong, and `Coins.Country` is a
 * display and search field (§4.2) — a Mexican coin findable only under
 * "United States" is still wrong.
 *
 * So the screen offers it, as the "or set the country" half of the ambiguous
 * fix. It OVERWRITES something the user typed, which is why it can only ever
 * happen because they ticked a box, and why the value written is the issuer
 * they just chose rather than anything inferred.
 *
 * @param group a group from `censusUnlinkedDenominations`
 * @param chosenDenominationId the row the user picked, or null
 * @param denominations the lookup, so the row can be verified as ACTIVE
 */
export function planUnlinkedFix(
  group: UnlinkedGroup,
  chosenDenominationId: number | null | undefined,
  denominations: readonly Denomination[],
  options: { setCountry?: boolean } = {}
): UnlinkedFixPlan {
  const refused = (refusal: string): UnlinkedFixPlan => ({
    denominationId: null,
    denominationLabel: '',
    issuerName: '',
    candidates: [],
    countryWrites: 0,
    refusal,
  });

  if (chosenDenominationId == null) return refused('Choose a denomination first.');

  const index = denominationIndexFor(denominations);
  const chosen = index.activeById.get(chosenDenominationId);

  /* An id that is absent, or that belongs to a row retired since the pane
   * was rendered. The server would accept the foreign key quite happily and
   * the coin would then point at a row nothing can display — `Other (...)`
   * with an id attached, which is worse than the state we started in. */
  if (!chosen) return refused('That denomination is no longer in the list.');

  const issuerName = issuerNameFor(index, denominationKey(chosen.label), chosen.denominationId);

  let countryWrites = 0;
  const candidates: UnlinkedFixCandidate[] = group.coins.map((coin) => {
    const updates: Record<string, unknown> = { denominationId: chosen.denominationId };

    // The editor's own writes: the label as text, plus the country when (and
    // only when) the coin has none and the answer is unambiguous.
    for (const write of denominationChoiceUpdates(chosen.label, coin.country, denominations)) {
      updates[write.field] = write.value;
    }

    // The explicit opt-in wins over the inference, because the user named an
    // issuer and an inference is a guess.
    if (options.setCountry && issuerName) updates['country'] = issuerName;

    const clean = onlyUnlinkedFixFields(updates as Partial<CoinRecord>);
    if (clean.country !== undefined) countryWrites += 1;

    return { coinId: coin.coinId, label: coin.label, updates: clean };
  });

  return {
    denominationId: chosen.denominationId,
    denominationLabel: chosen.label,
    issuerName,
    candidates,
    countryWrites,
    refusal: '',
  };
}

/**
 * The question put to the user before a bulk write.
 *
 * SAY THE NUMBER. Design §4.4 requires it of the delete dialog and the same
 * reasoning applies with more force here: "Link these coins?" with no figure
 * is how somebody rewrites forty rows meaning to rewrite four. The label is
 * quoted so a denomination with a space in it reads as one thing.
 *
 * The country line is SEPARATE and only appears when the box was ticked,
 * because that is the half of the action that overwrites something the user
 * typed rather than filling in something that was missing.
 *
 * A refused plan answers with its refusal, so the caller has one string to
 * show whatever state the screen is in.
 */
export function describeUnlinkedFixPlan(plan: UnlinkedFixPlan): string {
  if (plan.refusal) return plan.refusal;

  const count = plan.candidates.length;
  const coins = count === 1 ? '1 coin' : `${count} coins`;
  const issuer = plan.issuerName ? ` (${plan.issuerName})` : '';

  let message =
    `Link ${coins} to "${plan.denominationLabel}"${issuer}?\n\n` +
    `Their Denomination text will be set to "${plan.denominationLabel}".`;

  if (plan.countryWrites > 0) {
    const affected = plan.countryWrites === 1 ? '1 coin' : `${plan.countryWrites} coins`;
    message += `\nCountry will be set to "${plan.issuerName}" on ${affected}.`;
  }

  return message;
}

/**
 * What happened, in one sentence.
 *
 * A partial run is reported as "4 of 5", never as "linked 4 coins". The
 * second form is true and useless: the user asked about five, and the one
 * that did not make it would stay broken with nothing on screen saying so.
 */
export function describeUnlinkedFixOutcome(outcome: UnlinkedFixOutcome, label: string): string {
  if (outcome.failed === 0) {
    const coins = outcome.linked === 1 ? '1 coin' : `${outcome.linked} coins`;
    return `Linked ${coins} to "${label}".`;
  }

  const names = outcome.failures
    .map((failure) => `${failure.label} (${failure.reason})`)
    .join(', ');
  return (
    `Linked ${outcome.linked} of ${outcome.attempted} coins to "${label}". ` +
    `${outcome.failed} could not be saved: ${names}.`
  );
}

/**
 * Write a plan, one coin at a time.
 *
 * SEQUENTIAL AND AWAITED, for the reasons set out at length in
 * `runPmBackfill`: `InventoryService.updateCoin` schedules a write a second
 * later on a PER-COIN timer, so a loop over a group would fire every PUT in
 * the same millisecond at a SQL Server over a corporate network with no way
 * to report which ones failed. The caller wires `write` to
 * `updateCoinNow`, which issues the identical minimal-diff PUT immediately.
 *
 * A failed coin does NOT stop the run. "7 of 8 linked, here is the one that
 * failed" is a far better outcome than giving up halfway through a group and
 * leaving the user unable to tell which half was written.
 */
export async function runUnlinkedFix(
  plan: UnlinkedFixPlan,
  write: (coinId: string, updates: Partial<CoinRecord>) => Promise<void>
): Promise<UnlinkedFixOutcome> {
  const failures: UnlinkedFixOutcome['failures'] = [];
  let linked = 0;

  for (const candidate of plan.candidates) {
    try {
      await write(candidate.coinId, candidate.updates);
      linked += 1;
    } catch (error) {
      failures.push({
        coinId: candidate.coinId,
        label: candidate.label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    attempted: plan.candidates.length,
    linked,
    failed: failures.length,
    failures,
  };
}
