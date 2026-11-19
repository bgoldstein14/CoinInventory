/*
 * Denomination picker for the coin editor (about 1,160 denominations under 61 issuers).
 *
 * - The coin's country only ORDERS the list (its issuer first); it never filters it, so every
 *   issuer stays reachable even when the recorded country is wrong.
 * - The list is never empty: a search with no matches falls back to everything and reports
 *   noMatches.
 * - The coin's current denomination is always present exactly once, because a <select> whose
 *   value matches no option renders blank.
 * - Performance: denominationPickerBase (country resolution, alias folding) is memoised and
 *   independent of the search text; denominationPickerView is a cheap substring filter run per
 *   keystroke. Search results are capped at MAX_PICKER_OPTIONS to limit DOM rebuilds.
 *
 * Groups are issuer groups derived from Denominations.Country; that mapping lives in
 * services/denominations/denomination-index.ts.
 */

import { countryDisplayName } from '../../services/coin-countries';
import {
  denominationIndexFor,
  resolveIndexedDenomination
} from '../../services/denominations/denomination-index';
import { denominationKey } from './denomination-aliases';
import { preferredDenominationCountries } from './country-denomination-link';

/**
 * Maximum options rendered for a search (a DOM budget, not a data limit). Never applied to the
 * unfiltered list.
 */
export const MAX_PICKER_OPTIONS = 200;

/**
 * Heading for rows with no issuer. Should be unreachable (the column is NOT NULL), but rows
 * must never be dropped from the list.
 */
const UNFILED_HEADING = 'Unfiled';

/** The fields of a Denominations row the picker needs (satisfied by Denomination). */
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
  /** The <option> value: the id as a string, since labels like 'Crown' are not unique. */
  value: string;
  label: string;
  /** True for the coin's current denomination when it falls outside the country's issuer. */
  outOfCountry: boolean;
  /** True for the denomination the coin is currently on. */
  current: boolean;
}

/** One <optgroup>: an issuer heading and the options under it. Never empty. */
export interface DenominationPickerGroup {
  heading: string;
  /** The coin's country's issuer, rendered first. */
  preferred: boolean;
  /** The "On this coin" group. */
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
  /** How many options are rendered, including the current denomination if added back. */
  shownCount: number;
  /** More matches exist than are shown. */
  truncated: boolean;
  /** The query matched nothing, so the whole list is shown. */
  noMatches: boolean;
}

/** An option plus everything needed to place and to search it. */
interface PickerEntry {
  option: DenominationPickerOption;
  /** Identifies the group this entry belongs to. */
  groupKey: string;
  heading: string;
  preferred: boolean;
  /** This entry is in the "On this coin" group. */
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
  /** The coin's own denomination, wherever it ended up. */
  readonly currentEntry: PickerEntry | null;
}

/*
 * The lookup index is shared with the importers (services/denominations/denomination-index.ts);
 * only the per-coin base memo lives here.
 */

/** Memo of bases per lookup array (by identity, so it resets when the lookup is refetched). */
const BASE_CACHE = new WeakMap<
  readonly PickerDenomination[],
  Map<string, DenominationPickerBase>
>();

/** Bases remembered per lookup list; cleared wholesale when full. */
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
 * Uses preferredDenominationCountries, plus an exact issuer-name match for countries it cannot
 * place (e.g. 'Roman Empire'). The extra step can only add a preference, never narrow the list.
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
  /** 0 the coin's issuer, 1 the "On this coin" group, 2 everything else. */
  rank: number;
  /** Within rank 2: the US first, then alphabetical, unfiled last. */
  secondary: number;
}

function headingFor(country: string): string {
  return country ? countryDisplayName(country) : UNFILED_HEADING;
}

/**
 * Entries are already in display order, so a new group starts whenever the key changes. Groups
 * are therefore never empty.
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

    /*
     * Move the coin's denomination into its own group only when it is outside the preferred issuer
     * (and there is one); otherwise it already appears there.
     */
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
 * Expensive half of the picker, memoised on lookup array, country and current id. The coin
 * input changes identity on every edit, so without the memo every keystroke would rebuild it.
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
 * Per-keystroke half: apply the search text to a base. Substring match on a prebuilt haystack,
 * plus an alias match on the query.
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
  /* Alias-fold the query so e.g. 'Three Cent Silver' finds '3¢ Silver'. */
  const key = denominationKey(text);

  const matched: PickerEntry[] = [];
  for (const entry of base.entries) {
    if (entry.haystack.includes(needle) || (key !== '' && entry.aliasKey === key)) {
      matched.push(entry);
    }
  }

  /* No matches: show everything and flag it so the UI can say so. */
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

  /*
   * Add the coin's own denomination back if it was filtered out or capped, after any preferred
   * group, so the select never renders blank.
   */
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

/** Result of denominationSelectionFor. Display only. */
export interface DenominationSelection {
  /** The <select>'s value, or null for "(select)". */
  denominationId: number | null;
  /** That denomination's Label — the input to `denominationDisplay()`. */
  label: string | null;
  /** The custom (free-text) box should be open. */
  custom: boolean;
  /**
   * 'stored': the coin's own id; 'resolved': resolved from its text (shown, not saved);
   * 'none': nothing to select.
   */
  source: 'stored' | 'resolved' | 'none';
  /**
   * False until the lookup list has loaded. Custom mode must not be synced before then, or every
   * coin would open as custom.
   */
  ready: boolean;
}

/*
 * Which option a coin is on, and whether it needs the custom ("Other") box.
 *
 * A coin with no id is resolved from its text using the same resolver as the migrations and
 * importers ('$1', '3CS', or '8 Reales' under another issuer all resolve). The custom box opens
 * only when the text names no single denomination (ambiguous, unknown or deleted).
 * Nothing is written: a resolution is only displayed until the user picks something.
 */
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
    /* Dangling or retired id: fall through and judge the coin by its text. */
  }

  const text = String(recordedText ?? '').trim();
  if (!text) return { ...nothing, ready: true };

  /* Same resolver as the migrations/importers, via the shared index. */
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
 * Writes for picking "Other". The id is always cleared (null, since undefined is dropped from
 * the patch). The text is kept as the record of what the source said, unless it is just a
 * copy of the rejected label.
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

/** Label for a denomination id, or null. Retired rows return null. */
export function denominationLabelById(
  denominationId: number | null | undefined,
  denominations: readonly PickerDenomination[]
): string | null {
  if (denominationId === null || denominationId === undefined) return null;
  return denominationIndexFor(denominations).activeById.get(denominationId)?.label ?? null;
}
