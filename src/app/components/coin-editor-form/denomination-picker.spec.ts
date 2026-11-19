/*
 * Tests for the denomination picker model: type-ahead, country bias (orders, never limits),
 * never an empty list, and the coin's own denomination always shown. Pure functions only;
 * the suite runs under Node without a DOM.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PICKER_OPTIONS,
  PickerDenomination,
  denominationPickerBase,
  denominationPickerView,
  denominationSelectionFor,
  denominationLabelById,
  customDenominationWrites,
} from './denomination-picker';

/*
 * Fixture shaped like the seeded data: Denominations.Country holds an ISO code for modern
 * issuers and the full name for ancients.
 */
let nextId = 1;
function row(label: string, country: string, sortOrder = 0, isActive = true): PickerDenomination {
  return { denominationId: nextId++, label, country, sortOrder, isActive };
}

const US_CENT = row('1¢', 'US', 1);
const US_NICKEL = row('5¢', 'US', 2);
const US_QUARTER = row('25¢', 'US', 3);
const US_DOLLAR = row('$1', 'US', 4);
/** The real seeded label, as setup-database.sql writes it. */
const US_3CS = row('3CS', 'US', 5);

const GB_PENNY = row('1d', 'GB', 1);
const GB_SHILLING = row('1/-', 'GB', 2);
const GB_CROWN = row('5/- (Crown)', 'GB', 3);
const GB_SOVEREIGN = row('Sovereign', 'GB', 4);

const MX_8_REALES = row('8 Reales', 'MX', 1);
const MX_PESO = row('1 Peso', 'MX', 2);

const AU_CROWN = row('Crown', 'AU', 1);
const GB_PLAIN_CROWN = row('Crown', 'GB', 5);

const ROME_DENARIUS = row('Denarius', 'Roman Empire', 1);
const ROME_SESTERTIUS = row('Sestertius', 'Roman Empire', 2);

const RETIRED = row('Half Cent', 'US', 9, false);

const DENOMINATIONS: PickerDenomination[] = [
  US_CENT, US_NICKEL, US_QUARTER, US_DOLLAR, US_3CS,
  GB_PENNY, GB_SHILLING, GB_CROWN, GB_SOVEREIGN, GB_PLAIN_CROWN,
  MX_8_REALES, MX_PESO,
  AU_CROWN,
  ROME_DENARIUS, ROME_SESTERTIUS,
  RETIRED,
];

/** Every label the picker is currently offering, in order, groups flattened. */
function labelsOf(view: { groups: readonly { options: readonly { label: string }[] }[] }): string[] {
  return view.groups.flatMap((group) => group.options.map((option) => option.label));
}

/** The picker as the component builds it: base, then the per-keystroke view. */
function pick(country: string | null | undefined, currentId: number | null, query: string) {
  return denominationPickerView(denominationPickerBase(DENOMINATIONS, country, currentId), query);
}

/* ---- Country bias ---- */

describe('the coin country biases the list', () => {
  it('puts the coin country first', () => {
    const view = pick('Great Britain', null, '');
    expect(view.groups[0].heading).toBe('Great Britain');
    expect(view.groups[0].preferred).toBe(true);
  });

  it('STILL OFFERS EVERY OTHER ISSUER — the 8 Reales case', () => {
    // Imported Mexican coins can carry Country = 'United States'; '8 Reales' must still be reachable.
    const view = pick('United States', null, '');
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('offers the ancients to a modern coin and the moderns to an ancient one', () => {
    expect(labelsOf(pick('United States', null, ''))).toContain('Denarius');
    expect(labelsOf(pick('Roman Empire', null, ''))).toContain('$1');
  });

  it('offers exactly the same SET of denominations whatever the country', () => {
    // Bias only reorders: the set of entries must not change.
    const sortedLabels = (country: string) => labelsOf(pick(country, null, '')).sort();

    const everything = sortedLabels('');
    for (const country of ['United States', 'Great Britain', 'Mexico', 'Roman Empire', 'Ruritania']) {
      expect(sortedLabels(country), `country = ${country}`).toEqual(everything);
    }
  });

  it('names the group by the issuer, not by the stored code', () => {
    // The column holds 'MX'; the heading shows the readable name.
    const headings = pick('', null, '').groups.map((group) => group.heading);
    expect(headings).toContain('Mexico');
    expect(headings).toContain('Great Britain');
    expect(headings).toContain('Roman Empire');
    expect(headings).not.toContain('MX');
  });

  it('biases towards an ancient issuer no country vocabulary has heard of', () => {
    // 'Roman Empire' is not a country, so the bias comes from an exact issuer-name match.
    const view = pick('Roman Empire', null, '');

    expect(view.groups[0].heading).toBe('Roman Empire');
    expect(view.groups[0].preferred).toBe(true);
    expect(labelsOf(view).length).toBe(15);
  });

  it('marks only the coin country group as preferred', () => {
    const view = pick('Mexico', null, '');
    const preferred = view.groups.filter((group) => group.preferred);
    expect(preferred.map((group) => group.heading)).toEqual(['Mexico']);
  });

  it('never renders an empty group', () => {
    // No heading without options beneath it.
    for (const country of ['', 'United States', 'Ruritania', 'Peru']) {
      for (const group of pick(country, null, '').groups) {
        expect(group.options.length, `${country} / ${group.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it('leaves retired denominations out', () => {
    expect(labelsOf(pick('United States', null, ''))).not.toContain('Half Cent');
  });
});

/* ---- Never show an empty dropdown ---- */

describe('Rule 1: the dropdown is never empty', () => {
  it('shows everything when the country is blank', () => {
    expect(labelsOf(pick('', null, '')).length).toBe(15);
    expect(labelsOf(pick(null, null, '')).length).toBe(15);
    expect(labelsOf(pick('   ', null, '')).length).toBe(15);
  });

  it('shows everything for a country it cannot place', () => {
    const view = pick('Ruritania', null, '');
    expect(labelsOf(view).length).toBe(15);
    expect(view.groups.some((group) => group.preferred)).toBe(false);
  });

  it('shows everything for a recognised country with nothing on file', () => {
    // Peru is a known country with no denominations in this fixture.
    const view = pick('Peru', null, '');
    expect(labelsOf(view).length).toBe(15);
    expect(view.groups.some((group) => group.preferred)).toBe(false);
  });

  it('falls back to the whole list when a search matches nothing', () => {
    // A search must not empty the dropdown either.
    const view = pick('United States', null, 'xyzzy');
    expect(view.noMatches).toBe(true);
    expect(view.matchCount).toBe(0);
    expect(labelsOf(view).length).toBe(15);
  });

  it('says plainly that the search matched nothing, rather than lying about it', () => {
    expect(pick('', null, 'xyzzy').noMatches).toBe(true);
    expect(pick('', null, 'crown').noMatches).toBe(false);
    expect(pick('', null, '').noMatches).toBe(false);
  });
});

/* ---- Never drop the coin's own denomination ---- */

describe('Rule 2: the coin keeps what it already has, visibly', () => {
  it('keeps a Mexican denomination offered on a coin whose country says United States', () => {
    const view = pick('United States', MX_8_REALES.denominationId, '');
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('puts it in its own labelled group, naming where it belongs', () => {
    const view = pick('United States', MX_8_REALES.denominationId, '');
    const group = view.groups.find((candidate) => candidate.current);

    expect(group).toBeDefined();
    expect(group!.heading).toContain('Mexico');
    expect(group!.options.map((option) => option.label)).toEqual(['8 Reales']);
  });

  it('flags it as not matching the country, so the mismatch is visible', () => {
    const view = pick('United States', MX_8_REALES.denominationId, '');
    const option = view.groups.flatMap((group) => group.options).find((candidate) => candidate.current);

    expect(option?.outOfCountry).toBe(true);
  });

  it('offers it EXACTLY ONCE — a duplicated <option> is its own bug', () => {
    // Duplicate values would make the select highlight the first copy.
    const view = pick('United States', MX_8_REALES.denominationId, '');
    const occurrences = labelsOf(view).filter((label) => label === '8 Reales');
    expect(occurrences).toEqual(['8 Reales']);
  });

  it('does not hoist a denomination that already matches the country', () => {
    const view = pick('United States', US_QUARTER.denominationId, '');
    expect(view.groups.some((group) => group.current)).toBe(false);
    expect(labelsOf(view)).toContain('25¢');
  });

  it('SURVIVES THE SEARCH BOX, which is a second way to lose it', () => {
    // A select whose value matches no option renders blank.
    const view = pick('United States', MX_8_REALES.denominationId, 'denarius');

    expect(labelsOf(view)).toContain('8 Reales');
    expect(view.groups.find((group) => group.current)?.options[0].label).toBe('8 Reales');
  });

  it('keeps it even when the search matches nothing at all', () => {
    const view = pick('United States', MX_8_REALES.denominationId, 'xyzzy');
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('keeps it when it is the coin country entry and the search excludes it', () => {
    const view = pick('United States', US_QUARTER.denominationId, 'denarius');
    expect(labelsOf(view)).toContain('25¢');
  });

  it('still offers it exactly once when the search also matches it', () => {
    const view = pick('United States', MX_8_REALES.denominationId, 'reales');
    expect(labelsOf(view).filter((label) => label === '8 Reales')).toEqual(['8 Reales']);
  });

  it('adds no stray group when the coin has no denomination at all', () => {
    expect(pick('United States', null, '').groups.some((group) => group.current)).toBe(false);
  });

  it('adds no stray group when the coin points at a row that is gone', () => {
    // A dangling id must produce no group.
    expect(pick('United States', 9999, '').groups.some((group) => group.current)).toBe(false);
  });
});

/* ---- Type-ahead ---- */

describe('type-ahead search', () => {
  it('matches on part of the label', () => {
    expect(labelsOf(pick('', null, 'reales'))).toEqual(['8 Reales']);
  });

  it('is case-insensitive and ignores surrounding space', () => {
    expect(labelsOf(pick('', null, '  REALES  '))).toEqual(['8 Reales']);
  });

  it('matches on the issuer, so typing a country lists its denominations', () => {
    const labels = labelsOf(pick('', null, 'mexico'));
    expect(labels).toEqual(['8 Reales', '1 Peso']);
  });

  it('finds a denomination under a spelling the user knows but the table does not', () => {
    // Uses the alias table from denomination-aliases.ts. noMatches is checked because the
    // no-match fallback would otherwise contain '3CS' too.
    for (const spelling of ['Three Cent Silver', 'Trime', 'three cent silver']) {
      const view = pick('', null, spelling);
      expect(view.noMatches, spelling).toBe(false);
      expect(labelsOf(view), spelling).toEqual(['3CS']);
    }
  });

  it('searches across every issuer, not just the coin country', () => {
    // The search covers every issuer, not just the coin's country.
    const view = pick('United States', null, 'reales');
    expect(view.noMatches).toBe(false);
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('ranks the coin country first among the results', () => {
    // The bias still orders the search results.
    const view = pick('Great Britain', null, 'crown');
    expect(view.groups[0].heading).toBe('Great Britain');
    expect(view.groups[0].preferred).toBe(true);
    expect(labelsOf(view)).toContain('Crown');
  });

  it('keeps both of two identically-labelled denominations, under their own issuers', () => {
    // Same label under two issuers: both kept, distinguished by id.
    const view = pick('', null, 'crown');
    const headings = view.groups.filter((group) => group.options.length > 0).map((group) => group.heading);

    expect(headings).toContain('Australia');
    expect(headings).toContain('Great Britain');
  });

  it('reports how many it matched, so the user is told when there are more', () => {
    const view = pick('', null, 'crown');
    expect(view.matchCount).toBe(3);
    expect(view.shownCount).toBe(3);
    expect(view.truncated).toBe(false);
  });

  it('writes nothing — searching is not editing', () => {
    // Searching only produces a list; nothing is written.
    const view = pick('United States', MX_8_REALES.denominationId, 'crown');
    expect(Object.keys(view).sort()).toEqual(
      ['groups', 'matchCount', 'noMatches', 'query', 'shownCount', 'truncated']
    );
  });
});

/* ---- Performance ---- */

describe('filtering 1,161 entries does not make typing lag', () => {
  /** A corpus the size of the real seed: 61 issuers, 1,161 denominations. */
  const BIG: PickerDenomination[] = [];
  for (let issuer = 0; issuer < 61; issuer++) {
    for (let index = 0; index < 19; index++) {
      BIG.push({
        denominationId: 100000 + BIG.length,
        label: `Denom ${index} of ${issuer}`,
        country: `Issuer ${issuer}`,
        sortOrder: index,
        isActive: true,
      });
    }
  }

  it('built a corpus the size of the real seed, so the checks below are not vacuous', () => {
    expect(BIG.length).toBe(1159);
    expect(new Set(BIG.map((entry) => entry.country)).size).toBe(61);
  });

  it('builds the expensive half ONCE and hands back the same object again', () => {
    // The expensive base must be reused (same identity) while only the query changes.
    const first = denominationPickerBase(BIG, 'United States', null);
    const second = denominationPickerBase(BIG, 'United States', null);
    expect(second).toBe(first);
  });

  it('rebuilds when something it actually depends on changes', () => {
    // The base must rebuild when the country changes.
    const base = denominationPickerBase(BIG, 'United States', null);
    expect(denominationPickerBase(BIG, 'Great Britain', null)).not.toBe(base);
    expect(denominationPickerBase(BIG, 'United States', 100000)).not.toBe(base);
    expect(denominationPickerBase([...BIG], 'United States', null)).not.toBe(base);
  });

  it('answers a whole typed word, keystroke by keystroke, in well under a frame each', () => {
    // 260 filter passes; the loose budget catches an accidental per-keystroke rebuild, not machine speed.
    const base = denominationPickerBase(BIG, 'United States', null);
    const typed = 'Denom 7 of 13';

    const started = Date.now();
    for (let pass = 0; pass < 20; pass++) {
      for (let length = 1; length <= typed.length; length++) {
        denominationPickerView(base, typed.slice(0, length));
      }
    }
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
  });

  it('caps how many options it asks the browser to render, and says so', () => {
    // Search results are capped for rendering; the counts let the UI say there is more.
    const view = denominationPickerView(denominationPickerBase(BIG, '', null), 'Denom 1');

    expect(view.matchCount).toBeGreaterThan(MAX_PICKER_OPTIONS);
    expect(view.shownCount).toBe(MAX_PICKER_OPTIONS);
    expect(view.truncated).toBe(true);
    expect(labelsOf(view).length).toBe(MAX_PICKER_OPTIONS);
  });

  it('does NOT cap the unfiltered list — that would be a hard limit by the back door', () => {
    // No cap without a query, or later issuers would be unreachable.
    const view = denominationPickerView(denominationPickerBase(BIG, 'United States', null), '');

    expect(view.truncated).toBe(false);
    expect(labelsOf(view).length).toBe(BIG.length);
  });

  it('never lets the cap hide the denomination the coin already has', () => {
    // The coin's own denomination is added back even past the cap.
    const hidden = BIG.find((entry) => entry.label === 'Denom 0 of 60')!;
    const view = denominationPickerView(
      denominationPickerBase(BIG, 'Issuer 0', hidden.denominationId),
      'Denom 1'
    );

    expect(view.truncated).toBe(true);
    expect(labelsOf(view)).toContain('Denom 0 of 60');
    expect(view.groups.find((group) => group.current)?.options[0].label).toBe('Denom 0 of 60');
  });
});

/* ---- Selected option and "Other" ---- */

describe('denominationSelectionFor — which option is this coin on?', () => {
  it('sits on the stored id when there is one', () => {
    const selection = denominationSelectionFor(
      MX_8_REALES.denominationId, 'Pillar Dollar', 'United States', DENOMINATIONS
    );

    expect(selection.denominationId).toBe(MX_8_REALES.denominationId);
    expect(selection.label).toBe('8 Reales');
    expect(selection.custom).toBe(false);
    expect(selection.source).toBe('stored');
  });

  it('believes the id even when the recorded text disagrees with it', () => {
    // Normal post-import state: the text keeps the source wording; the id is authoritative.
    const selection = denominationSelectionFor(
      US_DOLLAR.denominationId, 'Trade Dollar', 'United States', DENOMINATIONS
    );
    expect(selection.label).toBe('$1');
    expect(selection.custom).toBe(false);
  });

  it('is nothing at all for a coin with neither an id nor any text', () => {
    const selection = denominationSelectionFor(null, '', 'United States', DENOMINATIONS);
    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(false);
    expect(selection.source).toBe('none');
  });

  /*
   * Coins with text but no id are resolved for display first; "Other" only when the text names
   * no single denomination. Nothing is written.
   */
  it('resolves the text for a coin the migration has not reached, and writes nothing', () => {
    const selection = denominationSelectionFor(null, '$1', 'United States', DENOMINATIONS);

    expect(selection.denominationId).toBe(US_DOLLAR.denominationId);
    expect(selection.label).toBe('$1');
    expect(selection.custom).toBe(false);
    expect(selection.source).toBe('resolved');
  });

  it('resolves through the alias table, so a Trime is not suddenly custom', () => {
    for (const spelling of ['3CS', 'Three Cent Silver', 'Trime', '3cs']) {
      const selection = denominationSelectionFor(null, spelling, 'United States', DENOMINATIONS);
      expect(selection.denominationId, spelling).toBe(US_3CS.denominationId);
      expect(selection.custom, spelling).toBe(false);
    }
  });

  it('resolves ACROSS issuers when the country names none — the 8 Reales case', () => {
    // Resolves across issuers when the country is wrong.
    const selection = denominationSelectionFor(null, '8 Reales', 'United States', DENOMINATIONS);

    expect(selection.denominationId).toBe(MX_8_REALES.denominationId);
    expect(selection.source).toBe('resolved');
    expect(selection.custom).toBe(false);
  });

  it('refuses to guess between two issuers, and calls that custom', () => {
    // Ambiguous across issuers: open the custom box rather than guess.
    const selection = denominationSelectionFor(null, 'Crown', 'United States', DENOMINATIONS);

    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('uses the country to break exactly that tie', () => {
    const selection = denominationSelectionFor(null, 'Crown', 'Australia', DENOMINATIONS);
    expect(selection.denominationId).toBe(AU_CROWN.denominationId);
    expect(selection.custom).toBe(false);
  });

  it('is custom for text no row names', () => {
    const selection = denominationSelectionFor(null, 'Trade Dollar', 'United States', DENOMINATIONS);
    expect(selection.denominationId).toBeNull();
    expect(selection.label).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('is custom for a coin whose denomination was deleted under it', () => {
    // Deleted denomination: id nulled, text kept; the retired row is not resurrected.
    const selection = denominationSelectionFor(null, 'Half Cent', 'United States', DENOMINATIONS);
    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('is custom for a coin still pointing at a row that has been retired', () => {
    // Defensive: a leftover retired id is not shown as selected.
    const selection = denominationSelectionFor(
      RETIRED.denominationId, 'Half Cent', 'United States', DENOMINATIONS
    );
    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('decides nothing at all before the lookup list has arrived', () => {
    // Not ready until lookups load; otherwise every coin would be marked custom for good.
    const selection = denominationSelectionFor(null, '$1', 'United States', []);
    expect(selection.custom).toBe(false);
    expect(selection.ready).toBe(false);
  });

  it('says it is ready once the list is there', () => {
    expect(denominationSelectionFor(null, '$1', 'United States', DENOMINATIONS).ready).toBe(true);
  });

  it('is not custom for blank text, however it is spelled', () => {
    for (const blank of ['', '   ', null, undefined]) {
      expect(denominationSelectionFor(null, blank, 'United States', DENOMINATIONS).custom).toBe(false);
    }
  });
});

/* ---- Picking "Other" ---- */

describe('customDenominationWrites — what picking Other saves', () => {
  const selectionFor = (id: number | null, text: string, country = 'United States') =>
    denominationSelectionFor(id, text, country, DENOMINATIONS);

  it('ALWAYS clears the link', () => {
    const writes = customDenominationWrites(
      selectionFor(US_DOLLAR.denominationId, '$1'), '$1'
    );
    expect(writes[0]).toEqual({ field: 'denominationId', value: null });
  });

  it('clears it as null, never undefined', () => {
    // Must be null: undefined is dropped from the patch.
    const writes = customDenominationWrites(selectionFor(US_DOLLAR.denominationId, '$1'), '$1');
    expect(writes[0].value).toBeNull();
    expect(writes[0].value).not.toBeUndefined();
  });

  it('clears the text when it is only a copy of the label being rejected', () => {
    // Text that just copies the rejected label is cleared.
    const writes = customDenominationWrites(selectionFor(US_DOLLAR.denominationId, '$1'), '$1');
    expect(writes).toContainEqual({ field: 'denomination', value: '' });
  });

  it('KEEPS imported text that disagrees with the link', () => {
    // Source wording that differs from the label is kept.
    const writes = customDenominationWrites(
      selectionFor(MX_8_REALES.denominationId, 'Pillar Dollar'), 'Pillar Dollar'
    );
    expect(writes).toEqual([{ field: 'denominationId', value: null }]);
  });

  it('keeps the user’s own spelling of a denomination that merely resolved', () => {
    // The user's own spelling is kept.
    const writes = customDenominationWrites(selectionFor(null, 'Trime'), 'Trime');
    expect(writes).toEqual([{ field: 'denominationId', value: null }]);
  });

  it('leaves an already-custom value completely alone', () => {
    // Re-opening the select must not wipe what the user typed.
    const writes = customDenominationWrites(selectionFor(null, 'Trade Dollar'), 'Trade Dollar');
    expect(writes).toEqual([{ field: 'denominationId', value: null }]);
  });

  it('writes only the link for a coin that had nothing recorded', () => {
    const writes = customDenominationWrites(selectionFor(null, ''), '');
    expect(writes).toEqual([{ field: 'denominationId', value: null }]);
  });

  it('never writes anything but those two fields', () => {
    // Picking "Other" never touches Country.
    for (const text of ['$1', 'Pillar Dollar', 'Trade Dollar', '']) {
      for (const write of customDenominationWrites(selectionFor(null, text), text)) {
        expect(['denominationId', 'denomination']).toContain(write.field);
      }
    }
  });
});

/* ---- Label for an id ---- */

describe('denominationLabelById', () => {
  it('answers the label for a live row', () => {
    expect(denominationLabelById(MX_8_REALES.denominationId, DENOMINATIONS)).toBe('8 Reales');
  });

  it('answers null for no id, an unknown id and a retired row', () => {
    expect(denominationLabelById(null, DENOMINATIONS)).toBeNull();
    expect(denominationLabelById(undefined, DENOMINATIONS)).toBeNull();
    expect(denominationLabelById(9999, DENOMINATIONS)).toBeNull();
    expect(denominationLabelById(RETIRED.denominationId, DENOMINATIONS)).toBeNull();
  });
});

/* ---- Option values ---- */

describe('option values', () => {
  it('carries the id, not the label', () => {
    // Option values are ids because labels are not unique.
    const view = pick('', null, 'crown');
    const values = view.groups.flatMap((group) => group.options).map((option) => option.value);

    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(String(AU_CROWN.denominationId));
    expect(values).toContain(String(GB_PLAIN_CROWN.denominationId));
  });

  it('gives every option a value a <select> can hold — a string', () => {
    for (const group of pick('', null, '').groups) {
      for (const option of group.options) {
        expect(typeof option.value).toBe('string');
        expect(option.value).toBe(String(option.denominationId));
      }
    }
  });

  it('can never collide with the custom sentinel or the empty option', () => {
    // No id may stringify to '' or the sentinel.
    for (const group of pick('', null, '').groups) {
      for (const option of group.options) {
        expect(option.value).not.toBe('');
        expect(option.value).not.toBe('__OTHER__');
      }
    }
  });
});
