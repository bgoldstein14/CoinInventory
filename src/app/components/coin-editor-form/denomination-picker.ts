 /*
 * denomination-picker.ts — the coin editor's denomination control, for a
 * reference table with 1,161 entries under 61 issuers.
 *
 * A dropdown nobody can use is a failure in its own right: several thousand
 * entries in one list is worse than the flat list it replaced. So this module
 * does three things, and the three pull against each other.
 *
 * 1. THE COUNTRY BIASES THE LIST. IT MUST NEVER LIMIT IT.
 *
 * The temptation with 1,161 entries is to scope the list to the coin's
 * country and be done. That fails a case this collection is full of: the
 * owner's `8 Reales` coins are stored with Country = 'United States', because
 * the QIF parser never set one. Scoping to the country would offer him every
 * US denomination and no way at all to reach the Mexican row he is looking
 * for — and he would have to know to correct the country first, which is the
 * thing he is trying to fix.
 *
 * The bias is therefore an ORDERING, not a filter. The coin's country's
 * issuer is rendered first, flagged `preferred`, and every other issuer
 * follows underneath. `denomination-picker.spec.ts` asserts that the SET of
 * denominations offered is byte-for-byte identical whatever the country is;
 * only the order changes.
 *
 * 2. THE TWO RULES FROM country-denomination-link.ts, BOTH INTACT
 *
 * Read that file's header. Each rule was a real, reported bug.
 *
 *   RULE 1 — NEVER SHOW AN EMPTY DROPDOWN. The three gates that decide
 *   whether the country may narrow anything are not re-derived here: they are
 *   `preferredDenominationCountries`, lifted out of that file so both
 *   controls ask one copy of the question. An empty answer means "show
 *   everything", never "show nothing".
 *
 *   The type-ahead is a SECOND WAY TO EMPTY THE DROPDOWN. A query matching
 *   nothing therefore falls back to the whole list and reports `noMatches`,
 *   so the control can say so. Falling back silently would be its own bug —
 *   the user would think their typo matched the entire collection.
 *
 *   RULE 2 — NEVER SILENTLY DROP THE DENOMINATION THE COIN ALREADY HAS. A
 *   <select> whose bound value matches no <option> renders BLANK. That is how
 *   the user comes to believe a saved field has been emptied, and the next
 *   thing they pick overwrites it for real. The coin's own denomination is
 *   therefore always present: in its own labelled group when it falls outside
 *   the country bias, and rescued into that same group when the search box
 *   would otherwise have filtered it away. Exactly once, never twice — two
 *   <option>s with the same value make the select highlight whichever comes
 *   first, so the user can be looking at a different row from the one the
 *   coin points at.
 *
 * 3. TYPING MUST NOT LAG, AND THAT IS A DESIGN CONSTRAINT, NOT A TUNING JOB
 *
 * The work splits into two stages on purpose, and the split is the whole
 * performance argument:
 *
 *   `denominationPickerBase` is the EXPENSIVE half. It resolves the coin's
 *   country against every issuer (`isSameCountry` carries seventy-odd regular
 *   expressions) and folds every label through the alias table. It depends on
 *   the lookup list, the coin's country and the coin's denomination id — and
 *   on NOTHING the user types into the search box. The component holds it in
 *   its own `computed()`, and it is memoised here as well, keyed on those
 *   three inputs, because the coin signal takes on a new identity on every
 *   keystroke in every OTHER field on the form.
 *
 *   `denominationPickerView` is the PER-KEYSTROKE half. One lower-cased
 *   `includes` against a pre-built haystack per row, plus one alias fold of
 *   the query itself — not of the 1,161 labels. No regular expressions, no
 *   allocation per row beyond the matches.
 *
 * The rendered list is capped as well, and that cap is about the DOM rather
 * than the filter: matching 1,161 strings takes microseconds, rebuilding
 * 1,161 <option> elements on every keystroke does not. The cap applies ONLY
 * when there is a query — capping the unfiltered list would make the 201st
 * issuer unreachable by scrolling, which is the "country hard-limits the
 * list" failure wearing a different hat. When it bites, the counts say so,
 * so the control can tell the user there is more and that typing finds it.
 *
 * WHERE "ISSUER" COMES FROM, GIVEN Issuers IS NOT ON THE WIRE YET
 *
 * Every seeded denomination is inserted with
 * `Country = COALESCE(Issuer.IsoCode, Issuer.Name)`, so the already published
 * `Denominations.Country` column holds 'MX' for Mexico and 'Roman Empire' for
 * the Roman Empire. THE GROUPS BELOW ARE ISSUER GROUPS; the column is called
 * Country, which is recorded as deliberate debt and a separate migration.
 * Nothing here needs the Issuers table on the wire, and when it arrives the
 * only change is where `headingFor` reads the name.
 *
 * Turning that column back into issuers is NOT done in this file —
 * services/denominations/denomination-index.ts owns it, and the importers
 * use the same copy. See the note there before changing how a heading or an
 * issuer name is derived; the two are not the same question, and conflating
 * them breaks resolution wholesale.
  */

import { countryDisplayName } from '../../services/coin-countries';
import {
  denominationIndexFor,
  resolveIndexedDenomination
} from '../../services/denominations/denomination-index';
import { denominationKey } from './denomination-aliases';
import { preferredDenominationCountries } from './country-denomination-link';

/**
 * How many options the control will ask the browser to render for a search.
 *
 * A RENDERING BUDGET, NOT A LIMIT ON THE DATA. A one-character query matches
 * hundreds of rows and the <option> elements are rebuilt on every keystroke;
 * that, not the string matching, is what makes typing feel slow. When the cap
 * bites, `matchCount` and `truncated` say so and the user types one more
 * letter. It is never applied to the unfiltered list.
 */
export const MAX_PICKER_OPTIONS = 200;

/**
 * The heading for rows with no issuer recorded at all.
 *
 * `Denominations.Country` is NOT NULL so this should be unreachable, and it
 * exists anyway because the alternative is worse in both directions: an
 * untitled <optgroup>, or — far worse — dropping the row from the list and
 * making a denomination that exists in the table impossible to pick.
 */
const UNFILED_HEADING = 'Unfiled';

/**
 * One row of the Denominations lookup, reduced to what the picker needs.
 *
 * Structurally satisfied by `types/coin.model.ts`'s `Denomination`. Declared
 * here rather than imported so this module states its own requirements and
 * does not have to change when that interface gains fields.
 */
export interface PickerDenomination {
  denominationId: number;
  label: string;
  /** The issuer, as `Denominations.Country` spells it — 'US', 'Roman Empire'. */
  country: string;
  sortOrder: number;
  isActive: boolean;
}

/** One <option>. */
export interface DenominationPickerOption {
  denominationId: number;
  /**
   * What the <option value> carries: the id, as a string.
   *
   * *** THE ID, NOT THE LABEL. *** 'Crown' is a British coin and an
   * Australian one. A control keyed by label cannot tell the user's choice
   * apart, and design §4.1 requires the id to be written.
   */
  value: string;
  label: string;
  /**
   * True only for the coin's existing denomination when it falls outside the
   * country bias. Rule 2; the template marks it so the mismatch is visible
   * rather than silent.
   */
  outOfCountry: boolean;
  /** True for the denomination the coin is currently on. */
  current: boolean;
}

/** One <optgroup>: an issuer heading and the options under it. Never empty. */
export interface DenominationPickerGroup {
  heading: string;
  /** The coin's country's issuer. Rendered first — this is the bias. */
  preferred: boolean;
  /** The "already on this coin" group. Rule 2. */
  current: boolean;
  options: DenominationPickerOption[];
}

/** Everything the template needs for one render. Nothing here is a write. */
export interface DenominationPickerView {
  groups: readonly DenominationPickerGroup[];
  /** The query, trimmed. */
  query: string;
  /** How many rows the query matched, BEFORE the rendering cap. */
  matchCount: number;
  /** How many options are actually rendered, including any Rule 2 rescue. */
  shownCount: number;
  /** The cap bit: there are more matches than are on screen. */
  truncated: boolean;
  /** The query matched nothing, so the whole list is shown instead. Rule 1. */
  noMatches: boolean;
}

/** An option plus everything needed to place and to search it. */
interface PickerEntry {
  option: DenominationPickerOption;
  /** Identifies the group this entry belongs to. */
  groupKey: string;
  heading: string;
  preferred: boolean;
  /** This entry is the Rule 2 group, hoisted out of its own issuer. */
  currentGroup: boolean;
  /** Lower-cased label and issuer, pre-joined. Built once, searched often. */
  haystack: string;
  /** The alias-folded label, so '3CS' finds '3¢ Silver'. Built once. */
  aliasKey: string;
}

/** The expensive half, computed once per (lookup, country, current id). */
export interface DenominationPickerBase {
  readonly entries: readonly PickerEntry[];
  /** The unfiltered view's groups, built here so the common case is free. */
  readonly groups: readonly DenominationPickerGroup[];
  /** The coin's own denomination, wherever it ended up. Rule 2's subject. */
  readonly currentEntry: PickerEntry | null;
}

 /*
 * THE LOOKUP INDEX — SHARED, not built here
 *
 * The index this control runs on — active rows by id, rows bucketed by their
 * alias-folded label, and one synthetic issuer per distinct
 * `Denominations.Country` value — lives in
 * services/denominations/denomination-index.ts, because the importers need
 * exactly the same index for exactly the same reason, and the
 * synthetic-issuer derivation is a RULE rather than a convenience.
 *
 * DO NOT FORK IT. Two copies would not fail a test: the editor would simply
 * offer a coin a denomination the CSV importer declined to link it to, on the
 * same data, with nothing anywhere saying so.
 *
 * What stays here is the one thing that is genuinely the picker's: the memo
 * of per-(country, current id) BASES, which is a cache for a control the
 * user is looking at and means nothing to an importer.
  */

/**
 * Per-lookup-array memo of the expensive half. Keyed on ARRAY IDENTITY,
 * because InventoryService hands out one array per fetch of the lookup, so
 * this is rebuilt when the lookup is refreshed and never while the user is
 * typing. A WeakMap so a replaced lookup list is collectable.
 */
const BASE_CACHE = new WeakMap<
  readonly PickerDenomination[],
  Map<string, DenominationPickerBase>
>();

/**
 * How many (country, current id) bases are remembered for one lookup list.
 *
 * Bounded because the key is derived from the coin being edited and a long
 * session visits many coins. Cleared wholesale rather than evicted one at a
 * time: this is a cache for a control the user is looking at, so the cost of
 * a cold rebuild is one frame and the bookkeeping for an LRU is not worth it.
 */
const MAX_REMEMBERED_BASES = 64;

function basesOf(
  denominations: readonly PickerDenomination[]
): Map<string, DenominationPickerBase> {
  let bases = BASE_CACHE.get(denominations);
  if (!bases) {
    bases = new Map();
    BASE_CACHE.set(denominations, bases);
  }
  return bases;
}

/* ---- The bias ---- */

/**
 * Which lookup `country` values the coin's country points at.
 *
 * `preferredDenominationCountries` is Rule 1's three gates, shared with the
 * existing filter, and it answers nothing for a country it cannot place.
 * That leaves the ancients out in the cold — `resolveCountryName('Roman
 * Empire')` is empty, because no country vocabulary contains it — and
 * ancients are explicitly in scope.
 *
 * So there is ONE additional, strictly additive step: a coin whose country
 * spells an issuer's own name character for character prefers that issuer.
 * It is the same precedence `denomination-resolution.ts` already applies and
 * for the same stated reason — an issuer the user named exactly outranks one
 * a regular expression thinks it recognises. It can only ever ADD a bias
 * where there was none, so neither gate can be loosened by it and the list
 * cannot be narrowed to nothing.
 */
function preferredCountriesFor(
  denominations: readonly PickerDenomination[],
  coinCountry: string | null | undefined
): Set<string> {
  const byTheRules = preferredDenominationCountries(denominations, coinCountry);
  if (byTheRules.length > 0) return new Set(byTheRules);

  const text = String(coinCountry ?? '').trim().toLowerCase();
  if (!text) return new Set();

  const named = new Set<string>();
  for (const row of denominations) {
    if (!row.isActive) continue;
    const country = String(row.country ?? '').trim();
    if (country.toLowerCase() === text) named.add(country);
  }
  return named;
}

/* ---- Building the list ---- */

interface GroupMeta {
  heading: string;
  preferred: boolean;
  current: boolean;
  /** 0 the coin's issuer, 1 the Rule 2 group, 2 everything else. */
  rank: number;
  /** Within rank 2: the US first, then alphabetical, unfiled last. */
  secondary: number;
}

function headingFor(country: string): string {
  return country ? countryDisplayName(country) : UNFILED_HEADING;
}

/**
 * Collapse a run of entries into groups.
 *
 * The entries are already in display order and every entry carries its
 * group's identity, so this is a single pass that starts a new group whenever
 * the key changes. A group can therefore never be empty, which is the
 * empty-<optgroup> bug `denomination-countries.ts` was written for.
 */
function collapse(entries: readonly PickerEntry[]): DenominationPickerGroup[] {
  const groups: DenominationPickerGroup[] = [];
  let openKey: string | null = null;

  for (const entry of entries) {
    if (entry.groupKey !== openKey) {
      groups.push({
        heading: entry.heading,
        preferred: entry.preferred,
        current: entry.currentGroup,
        options: []
      });
      openKey = entry.groupKey;
    }
    groups[groups.length - 1].options.push(entry.option);
  }

  return groups;
}

function buildBase(
  denominations: readonly PickerDenomination[],
  coinCountry: string | null | undefined,
  currentDenominationId: number | null | undefined
): DenominationPickerBase {
  const preferred = preferredCountriesFor(denominations, coinCountry);
  const currentId = currentDenominationId ?? null;

  const metaByKey = new Map<string, GroupMeta>();
  const rowsByKey = new Map<string, PickerDenomination[]>();

  for (const row of denominations) {
    if (!row.isActive) continue;

    const country = String(row.country ?? '').trim();
    const isPreferred = preferred.has(country);

    /* RULE 2's HOIST. The coin's own denomination is lifted into a group of
     * its own only when it falls OUTSIDE the bias — when it is inside it, it
     * is already visible where the user expects it and a second copy would
     * be a duplicate <option>. `preferred.size === 0` means there is no
     * country to be outside of, so nothing is hoisted either. */
    const hoist = currentId !== null && row.denominationId === currentId
      && !isPreferred && preferred.size > 0;

    const key = hoist ? '\u0000current' : country;
    const existing = metaByKey.get(key);
    if (!existing) {
      metaByKey.set(key, {
        heading: hoist ? `On this coin (${headingFor(country)})` : headingFor(country),
        preferred: isPreferred,
        current: hoist,
        rank: isPreferred ? 0 : hoist ? 1 : 2,
        secondary: country === 'US' ? 0 : country ? 1 : 2
      });
      rowsByKey.set(key, []);
    }
    rowsByKey.get(key)!.push(row);
  }

  const orderedKeys = [...metaByKey.keys()].sort((left, right) => {
    const a = metaByKey.get(left)!;
    const b = metaByKey.get(right)!;
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.secondary !== b.secondary) return a.secondary - b.secondary;
    const byHeading = a.heading.localeCompare(b.heading);
    return byHeading !== 0 ? byHeading : left.localeCompare(right);
  });

  const entries: PickerEntry[] = [];
  let currentEntry: PickerEntry | null = null;

  for (const key of orderedKeys) {
    const meta = metaByKey.get(key)!;
    const rows = rowsByKey.get(key)!;

    rows.sort((left, right) =>
      left.sortOrder !== right.sortOrder
        ? left.sortOrder - right.sortOrder
        : left.label.localeCompare(right.label)
    );

    for (const row of rows) {
      const isCurrent = currentId !== null && row.denominationId === currentId;
      const entry: PickerEntry = {
        option: {
          denominationId: row.denominationId,
          value: String(row.denominationId),
          label: row.label,
          outOfCountry: meta.current,
          current: isCurrent
        },
        groupKey: key,
        heading: meta.heading,
        preferred: meta.preferred,
        currentGroup: meta.current,
        haystack: `${row.label}\u0001${meta.heading}`.toLowerCase(),
        aliasKey: denominationKey(row.label)
      };
      entries.push(entry);
      if (isCurrent) currentEntry = entry;
    }
  }

  return { entries, groups: collapse(entries), currentEntry };
}

/**
 * The expensive half of the picker, memoised.
 *
 * Memoised on array identity plus the coin's country and denomination id, and
 * that memo is load-bearing rather than an optimisation: the component reads
 * the coin through an Angular `input()` signal, which takes on a NEW IDENTITY
 * on every field edit anywhere on the form. Without it, typing a purchase
 * price would re-resolve the coin's country against 61 issuers and re-fold
 * 1,161 labels through the alias table, on every keystroke, for a list that
 * had not changed.
 */
export function denominationPickerBase(
  denominations: readonly PickerDenomination[],
  coinCountry: string | null | undefined,
  currentDenominationId: number | null | undefined
): DenominationPickerBase {
  const bases = basesOf(denominations);
  const key = `${String(coinCountry ?? '')}\u0000${currentDenominationId ?? ''}`;

  const remembered = bases.get(key);
  if (remembered) return remembered;

  if (bases.size >= MAX_REMEMBERED_BASES) bases.clear();

  const base = buildBase(denominations, coinCountry, currentDenominationId);
  bases.set(key, base);
  return base;
}

/**
 * The per-keystroke half: apply the search box to a base.
 *
 * Pure, allocation-light and free of regular expressions. The only work per
 * row is one `String.includes` against a haystack built in the stage above
 * and one string comparison; the alias fold is applied to the QUERY, once,
 * not to the 1,161 labels.
 */
export function denominationPickerView(
  base: DenominationPickerBase,
  query: string | null | undefined
): DenominationPickerView {
  const text = String(query ?? '').trim();
  const total = base.entries.length;

  if (!text) {
    return {
      groups: base.groups,
      query: '',
      matchCount: total,
      shownCount: total,
      truncated: false,
      noMatches: false
    };
  }

  const needle = text.toLowerCase();
  /* The alias table, applied to what the user typed. This is what makes
   * 'Three Cent Silver' find the seeded '3¢ Silver' — a spelling no substring
   * match could ever connect. One fold per keystroke; the labels were folded
   * once, when the base was built. A second alias table here would be a
   * second vocabulary to keep in step with denomination-aliases.ts, and the
   * editor and the migration would stop agreeing about what a coin is. */
  const key = denominationKey(text);

  const matched: PickerEntry[] = [];
  for (const entry of base.entries) {
    if (entry.haystack.includes(needle) || (key !== '' && entry.aliasKey === key)) {
      matched.push(entry);
    }
  }

  /* RULE 1, APPLIED TO THE SEARCH BOX. The type-ahead did not exist when the
   * rule was written and it is a new way to empty the dropdown. A query that
   * matches nothing shows everything instead — and SAYS so, because falling
   * back silently would leave the user believing their typo matched the whole
   * collection. */
  if (matched.length === 0) {
    return {
      groups: base.groups,
      query: text,
      matchCount: 0,
      shownCount: total,
      truncated: false,
      noMatches: true
    };
  }

  const capped = matched.length > MAX_PICKER_OPTIONS;
  const shown = capped ? matched.slice(0, MAX_PICKER_OPTIONS) : matched;
  const groups = collapse(shown);

  /* RULE 2, APPLIED TO THE SEARCH BOX, AND IT OUTRANKS THE CAP.
   *
   * A <select> whose bound value matches no rendered <option> goes BLANK.
   * Narrowing the list by typing must not be able to do that: the user would
   * read the blank as "the field has been cleared" and the next thing they
   * picked would make it true. So the coin's own denomination comes back, in
   * its own labelled group, whether it was filtered out or merely pushed past
   * the rendering budget.
   *
   * It is inserted AFTER any preferred group, matching where
   * `denominationOptionGroups` has always put it, and only when it is not
   * already on screen — the same value twice would make the select highlight
   * the first copy, which may not be the row the coin points at. */
  const current = base.currentEntry;
  if (current && !shown.includes(current)) {
    const after = groups.findIndex((group) => !group.preferred);
    groups.splice(after < 0 ? groups.length : after, 0, {
      heading: current.currentGroup
        ? current.heading
        : `On this coin (${current.heading})`,
      preferred: false,
      current: true,
      options: [current.option]
    });
  }

  return {
    groups,
    query: text,
    matchCount: matched.length,
    shownCount: groups.reduce((count, group) => count + group.options.length, 0),
    truncated: capped,
    noMatches: false
  };
}

/* ---- Which option is this coin on, and what does "Other" mean? ---- */

/**
 * The answer `denominationSelectionFor` gives. Nothing here is a write.
 */
export interface DenominationSelection {
  /** The <select>'s value, or null for "(select)". */
  denominationId: number | null;
  /** That denomination's Label — the input to `denominationDisplay()`. */
  label: string | null;
  /** The free-text box must be open. See the note below on what that means. */
  custom: boolean;
  /**
   *   'stored'   — the coin's own DenominationId, resolved to a live row.
   *   'resolved' — no id on the coin; its text names exactly one row. SHOWN,
   *                NOT SAVED.
   *   'none'     — nothing to sit on.
   */
  source: 'stored' | 'resolved' | 'none';
  /**
   * False while the lookup list has not arrived from the server.
   *
   * Judged against an empty list every coin looks unresolvable, so every
   * denomination box in the app would open as a free-text field — and
   * `CustomOptionMode` derives once per coin and then stops, so it would open
   * that way and STAY that way. The caller must not sync custom mode until
   * this is true.
   */
  ready: boolean;
}

/* ---------------------------------------------------------------------------
 * *** WHAT "OTHER" MEANS. READ THIS BEFORE CHANGING ANYTHING BELOW. ***
 *
 * A coin can hold denomination text with NO id, and that is not exceptional:
 * it is the normal outcome of an import whose text resolved to nothing. So
 * the naive rule — "no id means custom" — is a trap. On an un-migrated
 * database that is every coin, every denomination box in the app would open
 * as a free-text field, and the owner would reasonably conclude the upgrade
 * had destroyed his dropdown. It is also wrong on its own terms: a coin
 * reading '$1' is not a coin whose denomination is unknown.
 *
 * The rule implemented here is one step further on, and it is the honest one:
 *
 *     "OTHER" MEANS THE COIN'S TEXT NAMES NO SINGLE DENOMINATION WE CAN OFFER.
 *
 * An id-less coin has its text put through `resolveDenomination` — the SAME
 * resolver the migrations and the importers use, not a second copy of the
 * rules — and only when that cannot name exactly one row does the custom box
 * open. That covers three distinct cases with one rule, and all three are
 * correct:
 *
 *   '$1', '3CS', 'Trime'  -> resolves. The select sits on the row.
 *   '8 Reales' with Country = 'United States'
 *                         -> resolves ACROSS issuers, which is the whole
 *                            point of biasing rather than filtering by
 *                            country. This is the coin the refactor exists
 *                            for.
 *   'Crown', 'Trade Dollar', a denomination the user deleted
 *                         -> does not resolve, or resolves ambiguously. The
 *                            box opens holding the text. `Crown` under two
 *                            issuers has no right answer, and inventing one
 *                            files the coin under an issuer the owner never
 *                            chose, invisibly and for good.
 *
 * *** NOTHING HERE WRITES. *** A resolution is SHOWN, never saved. The id is
 * written only when the user picks something, which is the one moment the app
 * is entitled to say what the coin is. Saving a guess on render would rewrite
 * the owner's collection as a side effect of scrolling through it.
 * ------------------------------------------------------------------------ */
export function denominationSelectionFor(
  storedId: number | null | undefined,
  recordedText: string | null | undefined,
  coinCountry: string | null | undefined,
  denominations: readonly PickerDenomination[]
): DenominationSelection {
  const nothing: DenominationSelection = {
    denominationId: null,
    label: null,
    custom: false,
    source: 'none',
    ready: denominations.length > 0
  };

  if (!nothing.ready) return nothing;

  const index = denominationIndexFor(denominations);

  if (storedId !== null && storedId !== undefined) {
    const row = index.activeById.get(storedId);
    if (row) {
      return {
        denominationId: row.denominationId,
        label: row.label,
        custom: false,
        source: 'stored',
        ready: true
      };
    }
    /* A dangling or retired id. The id is nulled when a denomination is
     * deleted, so this should not happen — but a hand-edited row or an older
     * build could leave one behind, and showing a retired row as the selected
     * option would offer the user something that is not in the list. Fall
     * through and judge the coin by its text, which is what it has left. */
  }

  const text = String(recordedText ?? '').trim();
  if (!text) return { ...nothing, ready: true };

  /* The SAME resolver the migrations and the importers use, asked through
   * the shared index so the 1,161 alias folds happen once per lookup list
   * rather than once per render. `resolveIndexedDenomination` is
   * `resolveDenomination` with the candidates pre-filtered; the sweep in
   * denomination-index.spec.ts asserts the two agree on the real seed. */
  const match = resolveIndexedDenomination(text, coinCountry, index);

  if (match.denominationId !== null) {
    const row = index.activeById.get(match.denominationId);
    if (row) {
      return {
        denominationId: row.denominationId,
        label: row.label,
        custom: false,
        source: 'resolved',
        ready: true
      };
    }
  }

  return { denominationId: null, label: null, custom: true, source: 'none', ready: true };
}

/** One single-field write. The caller sends each one separately. */
export interface DenominationFieldWrite {
  field: 'denominationId' | 'denomination';
  value: number | string | null;
}

/**
 * What picking "Other" writes.
 *
 * *** THE LINK ALWAYS GOES. *** A custom value has no id by definition, and
 * leaving the old one behind would make the coin go on reading as the
 * denomination the user has just rejected. `null`, never `undefined`:
 * undefined is stripped from the patch before it is sent, so the column would
 * keep the stale id and nothing would say so.
 *
 * *** THE TEXT USUALLY STAYS. *** The text is WHAT THE SOURCE SAID — the only
 * surviving record of what a QIF, a CSV or a spreadsheet actually contained —
 * and the id is the answer. A coin whose id says '8 Reales' while its text
 * says 'Pillar Dollar' is in the normal post-import state, and clearing that
 * text because the user rejected the id would destroy evidence the schema
 * spends a whole column preserving.
 *
 * So the text is cleared in exactly one case: when it is nothing more than a
 * copy of the label being rejected. That is the state the picker itself
 * creates — picking a denomination writes both fields to the same thing — so
 * it covers every coin the user has ever chosen a denomination for. Anything
 * else is the user's own wording or the source's, and it survives, visibly,
 * in the box that has just opened.
 */
export function customDenominationWrites(
  selection: DenominationSelection,
  recordedText: string | null | undefined
): DenominationFieldWrite[] {
  const writes: DenominationFieldWrite[] = [{ field: 'denominationId', value: null }];

  const text = String(recordedText ?? '').trim();
  const label = String(selection.label ?? '').trim();

  if (text.length > 0 && label.length > 0 && text === label) {
    writes.push({ field: 'denomination', value: '' });
  }

  return writes;
}

/**
 * The Label behind a DenominationId, or null.
 *
 * Exists so the editor can feed `denominationDisplay()` — the ONE place the
 * display rule of §4.1 is written down — without anybody reaching into the
 * lookup list and re-deriving "and if it is not there...". A retired row
 * answers null deliberately: it is no longer offered anywhere, so a coin
 * still pointing at one reads as unresolved, which is what it is.
 */
export function denominationLabelById(
  denominationId: number | null | undefined,
  denominations: readonly PickerDenomination[]
): string | null {
  if (denominationId === null || denominationId === undefined) return null;
  return denominationIndexFor(denominations).activeById.get(denominationId)?.label ?? null;
}
