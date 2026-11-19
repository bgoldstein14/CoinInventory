 /*
  * In-app view of coins with no denomination link, grouped so one decision
  * fixes many coins. Unlinked coins keep arising after migration 014: deleting a
  * denomination nulls its coins' ids (§4.4), imports can write text that
  * resolves to nothing (§4.1), and adding a missing denomination makes coins
  * linkable but not yet linked.
  *
  * Groups are keyed by the alias key of the recorded text (`denominationKey`, so
  * `3CS` and `Three Cent Silver` are one group) plus the resolved id, so a
  * 'Penny' filed under Great Britain never shares a bulk action with an
  * Australian one.
  *
  * Reasons (relabelled from `resolveDenomination`'s outcome):
  *   'resolvable'       the resolver can place the coin; it just isn't linked yet
  *                      (e.g. after the user added the missing denomination)
  *   'ambiguous'        several issuers struck this name; candidates are offered
  *   'unknown'          text recorded but no reference row names it
  *   'nothing-recorded' nothing usable recorded
  *
  * "Is anything recorded?" is answered by `denominationDisplay` (checking for
  * `NO_DENOMINATION`), not the resolver, so residue such as `__OTHER__` counts as
  * nothing recorded (not "unknown, add it") and the screen agrees with the grid.
  *
  * Plan/run split as in pm-backfill.ts: `planUnlinkedFix` is pure and returns
  * the exact payloads; `runUnlinkedFix` writes exactly those.
  */

import { denominationKey } from '../../components/coin-editor-form/denomination-aliases';
import { denominationChoiceUpdates } from '../../components/coin-editor-form/country-denomination-link';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { NO_DENOMINATION, denominationDisplay } from './denomination-display';
import { denominationIndexFor, resolveIndexedDenomination, type DenominationIndex } from './denomination-index';

/** Why a coin has no denomination link (see the file header). */
export type UnlinkedReason = 'resolvable' | 'ambiguous' | 'unknown' | 'nothing-recorded';

/**
 * Display order, as a cleanup order: 'resolvable' first (one click, no
 * judgement), 'nothing-recorded' last (no candidates to offer).
 */
const REASON_RANK: Readonly<Record<UnlinkedReason, number>> = {
  resolvable: 0,
  ambiguous: 1,
  unknown: 2,
  'nothing-recorded': 3,
};

/** The heading for the group of coins with nothing usable recorded. */
export const NOTHING_RECORDED_HEADING = 'Nothing recorded';

export interface UnlinkedCoinRef {
  coinId: string;
  /**
   * A short, recognisable name for the row. Excludes the denomination (the group
   * heading shows it); the country distinguishes rows and may need correcting.
   */
  label: string;
  /** `Coins.Denomination`, trimmed; empty when nothing usable was recorded. */
  recordedText: string;
  /** `Coins.Country`, trimmed; shown because the resolver uses it to break ties. */
  country: string;
}

/** A denomination the user could pick for a whole group. */
export interface UnlinkedChoice {
  denominationId: number;
  label: string;
  /** '' only for a row with no issuer. */
  issuerName: string;
}

/** Coins asking one question, with one answer to give. */
export interface UnlinkedGroup {
  /** Stable identity for `@for (... ; track group.key)`. */
  key: string;
  reason: UnlinkedReason;
  /** Distinct recorded spellings, sorted; empty for 'nothing-recorded'. */
  recordedTexts: readonly string[];
  /** Distinct coin countries, sorted; blanks omitted. */
  countries: readonly string[];
  heading: string;
  coins: readonly UnlinkedCoinRef[];
  coinCount: number;
  /**
   * Choices offered without searching: every candidate for 'ambiguous', the
   * single answer for 'resolvable', none otherwise. Sorted by issuer, then label.
   */
  choices: readonly UnlinkedChoice[];
}

export interface UnlinkedCensus {
  /**
   * False until `GET /api/denominations` has returned. With an empty lookup every
   * coin would appear unlinked, so the census stays empty until then.
   */
  lookupLoaded: boolean;
  /** Coins looked at, drafts included. */
  totalCoins: number;
  /** Coins in `groups`; zero is a real answer. */
  unlinkedCount: number;
  groups: readonly UnlinkedGroup[];
  /** Always all four keys, zeros included. */
  countsByReason: Readonly<Record<UnlinkedReason, number>>;
  /** Rows never written to the database (being typed); nothing to PUT. */
  skippedDraftCount: number;
}

 /* The census */

/** The issuer name the index reconstructed for a candidate row. */
function issuerNameFor(index: DenominationIndex, aliasKey: string, denominationId: number): string {
  const bucket = index.byAliasKey.get(aliasKey);
  if (!bucket) return '';

  const candidate = bucket.candidates.find((row) => row.denominationId === denominationId);
  if (!candidate || candidate.issuerId === null) return '';

  return bucket.issuers.find((issuer) => issuer.issuerId === candidate.issuerId)?.name ?? '';
}

/**
 * Turns candidate ids into choices, taking labels and issuer names from the
 * index's bucket rather than re-deriving them (see denomination-index.ts).
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

/** Short name for one row; falls back to the coin id so an empty record is still identifiable. */
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
 * Coins with no denomination link, grouped by the question they ask.
 *
 * @param coins the inventory as the user sees it
 * @param denominations the lookup from the denominations signal; empty means
 *   "not loaded yet" and gives an empty census (see `lookupLoaded`)
 * @param isDraft whether a row has never reached the database (passed in to keep this pure)
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

    /* Linked to an active row? A coin pointing at a soft-deleted row displays as
     * `Other (...)` like an unlinked one, so it belongs here too. */
    if (coin.denominationId != null && index.activeById.has(coin.denominationId)) continue;

    const recordedText = String(coin.denomination ?? '').trim();
    const country = String(coin.country ?? '').trim();

    /* Anything recorded? Asked of the display rule, so `__OTHER__` counts as blank. */
    const hasText = denominationDisplay(null, recordedText) !== NO_DENOMINATION;

    let reason: UnlinkedReason;
    let aliasKey = '';
    let candidateIds: readonly number[] = [];
    let resolvedId: number | null = null;

    if (!hasText) {
      // One group for all coins with nothing usable recorded.
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
          /* 'empty' is unreachable here (`hasText` is true); kept so a folding change
           * can't produce a reason the switch below doesn't handle. */
          reason = 'nothing-recorded';
          aliasKey = '';
          candidateIds = [];
          break;
      }
    }

    /* The key includes the resolved id, so 'Penny' under different countries
     * forms different groups. */
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

  /* Cheapest fixes first, then largest, then alphabetical, then by key (the only
   * unique tie-break, so two groups with the same heading sort deterministically). */
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
 * The count as a sentence, including when zero, with the denominator ("0 of
 * 105") so it can be checked. '' before the lookup has arrived.
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
 * What is wrong with a group, in plain words for a collector, including the
 * fix (the resolver's terms are jargon to the user).
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

/* The fix */

/**
 * The only columns this feature may write. Exported so the payload test uses
 * the same list (as in pm-backfill.ts): this is a bulk writer.
 */
export const UNLINKED_FIX_FIELDS = ['denomination', 'denominationId', 'country'] as const;

/** Strips a payload down to UNLINKED_FIX_FIELDS. */
export function onlyUnlinkedFixFields(updates: Partial<CoinRecord>): Partial<CoinRecord> {
  const allowed = new Set<string>(UNLINKED_FIX_FIELDS);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.has(key)) clean[key] = value;
  }
  return clean as Partial<CoinRecord>;
}

/** One coin the fix will write, and exactly what it will send. */
export interface UnlinkedFixCandidate {
  coinId: string;
  label: string;
  updates: Partial<CoinRecord>;
}

export interface UnlinkedFixPlan {
  /** The chosen row, or null when the plan refused. */
  denominationId: number | null;
  /** The chosen row's Label (written as the text); '' when refused. */
  denominationLabel: string;
  /** The chosen row's issuer, for the confirmation sentence. */
  issuerName: string;
  candidates: readonly UnlinkedFixCandidate[];
  /** How many of those payloads also rewrite `Coins.Country`. */
  countryWrites: number;
  /** Why there is nothing to do, or ''. A refusal (e.g. nothing picked) is a normal state. */
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
 * Uses `denominationChoiceUpdates`, the editor's own path, so a coin fixed here
 * ends up identical to one fixed in the editor: the chosen row's label is
 * written as the text (§4.1), and Country is filled only when the coin has none
 * and exactly one issuer fits.
 *
 * `setCountry` is opt-in only. QIF-imported coins may say 'United States' while
 * being Mexican; ticking it overwrites the country with the chosen issuer.
 *
 * @param group a group from `censusUnlinkedDenominations`
 * @param chosenDenominationId the row the user picked, or null
 * @param denominations the lookup, to verify the row is still active
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

  /* An absent or retired id: linking to it would give the coin an id nothing
   * can display. */
  if (!chosen) return refused('That denomination is no longer in the list.');

  const issuerName = issuerNameFor(index, denominationKey(chosen.label), chosen.denominationId);

  let countryWrites = 0;
  const candidates: UnlinkedFixCandidate[] = group.coins.map((coin) => {
    const updates: Record<string, unknown> = { denominationId: chosen.denominationId };

    // The editor's writes: label as text, plus country only when missing and unambiguous.
    for (const write of denominationChoiceUpdates(chosen.label, coin.country, denominations)) {
      updates[write.field] = write.value;
    }

    // An explicit opt-in overrides the inference.
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
 * The confirmation question before a bulk write. States the number of coins
 * and quotes the label; the country change is a separate line, shown only when
 * ticked. A refused plan returns its refusal.
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

/** What happened, in one sentence; partial runs read "4 of 5". */
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
 * Writes a plan one coin at a time, sequentially and awaited (as in
 * `runPmBackfill`): `updateCoin` debounces per coin, so the caller wires `write`
 * to `updateCoinNow`. A failed coin doesn't stop the run.
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
