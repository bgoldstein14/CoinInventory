 /*
 * denomination-picker.spec.ts — the editor's denomination picker
 *
 * The seed (migration 013) puts 1,161 denominations under 61 issuers into a
 * control that was a flat <select> grouped by country. The design calls a
 * dropdown nobody can use a failure even if it works (§2, anti-goals), so
 * this picker has to do three things at once and the three pull against each
 * other:
 *
 *   TYPE-AHEAD, so 1,161 entries are reachable by typing rather than
 *   scrolling.
 *
 *   A COUNTRY THAT BIASES AND NEVER LIMITS (§4.7). The owner's own 8 Reales
 *   coins are stored with Country = 'United States', because the QIF parser
 *   never set one. A country-scoped list would fail the exact case that
 *   prompted the entire refactor.
 *
 *   THE TWO RULES FROM country-denomination-link.ts, BOTH INTACT. Each was a
 *   real reported bug: never show an empty dropdown, and never silently drop
 *   the denomination the coin already has.
 *
 * Every test below names which of those it is defending.
 *
 * The suite runs under plain Node with no jsdom, so there is no template
 * here — only the pure model the thin component binds to.
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
 * A fixture shaped like the real thing after migration 013.
 *
 * Note what `Denominations.Country` holds: the seed writes
 * COALESCE(Issuer.IsoCode, Issuer.Name), so modern issuers appear as a
 * two-letter code and ancients appear under their full name. That column IS
 * the issuer, under an older name that §4.2 keeps as flagged debt.
  */
let nextId = 1;
function row(label: string, country: string, sortOrder = 0, isActive = true): PickerDenomination {
  return { denominationId: nextId++, label, country, sortOrder, isActive };
}

const US_CENT = row('1¢', 'US', 1);
const US_NICKEL = row('5¢', 'US', 2);
const US_QUARTER = row('25¢', 'US', 3);
const US_DOLLAR = row('$1', 'US', 4);
/** The real seeded label, as setup-database.sql writes it. Not '3 cent silver'. */
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

 /*
 * THE COUNTRY BIASES THE LIST — IT NEVER LIMITS IT
  */

describe('the coin country biases the list', () => {
  it('puts the coin country first', () => {
    const view = pick('Great Britain', null, '');
    expect(view.groups[0].heading).toBe('Great Britain');
    expect(view.groups[0].preferred).toBe(true);
  });

  it('STILL OFFERS EVERY OTHER ISSUER — the 8 Reales case', () => {
    // *** THE TEST THIS WHOLE REFACTOR EXISTS FOR. ***
    // The owner's Mexican coins are stored with Country = 'United States'
    // because the QIF parser never set one. He must be able to find
    // '8 Reales' without first correcting the country field. A list scoped
    // to the country would resolve nothing for precisely this coin.
    const view = pick('United States', null, '');
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('offers the ancients to a modern coin and the moderns to an ancient one', () => {
    expect(labelsOf(pick('United States', null, ''))).toContain('Denarius');
    expect(labelsOf(pick('Roman Empire', null, ''))).toContain('$1');
  });

  it('offers exactly the same SET of denominations whatever the country', () => {
    // Bias is an ORDERING. If any country ever removed an entry from the
    // list, this is where it would show.
    const sortedLabels = (country: string) => labelsOf(pick(country, null, '')).sort();

    const everything = sortedLabels('');
    for (const country of ['United States', 'Great Britain', 'Mexico', 'Roman Empire', 'Ruritania']) {
      expect(sortedLabels(country), `country = ${country}`).toEqual(everything);
    }
  });

  it('names the group by the issuer, not by the stored code', () => {
    // 'MX' is what the column holds; 'Mexico' is what the user reads. The
    // seed fills Denominations.Country from the issuer's IsoCode or Name,
    // so the heading IS the issuer.
    const headings = pick('', null, '').groups.map((group) => group.heading);
    expect(headings).toContain('Mexico');
    expect(headings).toContain('Great Britain');
    expect(headings).toContain('Roman Empire');
    expect(headings).not.toContain('MX');
  });

  it('biases towards an ancient issuer no country vocabulary has heard of', () => {
    // `resolveCountryName('Roman Empire')` is empty — it is not a country and
    // never will be — so Rule 1's second gate declines to narrow, which is
    // correct for the FILTER and leaves an ancient coin with no bias at all.
    // The design puts ancients explicitly in scope (§4.3), so the picker adds
    // one strictly additive step: a country that spells an issuer's own name
    // character for character prefers that issuer. The same precedence
    // denomination-resolution.ts already applies, for the same reason.
    const view = pick('Roman Empire', null, '');

    expect(view.groups[0].heading).toBe('Roman Empire');
    expect(view.groups[0].preferred).toBe(true);
    // ...and it is still only a bias.
    expect(labelsOf(view).length).toBe(15);
  });

  it('marks only the coin country group as preferred', () => {
    const view = pick('Mexico', null, '');
    const preferred = view.groups.filter((group) => group.preferred);
    expect(preferred.map((group) => group.heading)).toEqual(['Mexico']);
  });

  it('never renders an empty group', () => {
    // The bug denomination-countries.ts was written for: a heading with
    // nothing beneath it.
    for (const country of ['', 'United States', 'Ruritania', 'Peru']) {
      for (const group of pick(country, null, '').groups) {
        expect(group.options.length, `${country} / ${group.heading}`).toBeGreaterThan(0);
      }
    }
  });

  it('leaves retired denominations out', () => {
    // The template does not render them, so counting them would reproduce
    // the empty-heading bug and would offer a row that no longer exists.
    expect(labelsOf(pick('United States', null, ''))).not.toContain('Half Cent');
  });
});

/* ===========================================================================
 * RULE 1 — NEVER SHOW AN EMPTY DROPDOWN
 * (country-denomination-link.ts, and it was a real bug)
 * ======================================================================== */

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
    // Peru is in the country vocabulary and has no denominations seeded in
    // this fixture. Narrowing to it would empty the list.
    const view = pick('Peru', null, '');
    expect(labelsOf(view).length).toBe(15);
    expect(view.groups.some((group) => group.preferred)).toBe(false);
  });

  it('falls back to the whole list when a search matches nothing', () => {
    // The type-ahead is new and it is a filter, so it is a NEW WAY TO EMPTY
    // THE DROPDOWN. Rule 1 has to cover it too, or a typo leaves the user
    // with no option to pick and a control that looks broken.
    const view = pick('United States', null, 'xyzzy');
    expect(view.noMatches).toBe(true);
    expect(view.matchCount).toBe(0);
    expect(labelsOf(view).length).toBe(15);
  });

  it('says plainly that the search matched nothing, rather than lying about it', () => {
    // Falling back silently would be its own bug: the user would think
    // 'xyzzy' matched every denomination in the collection.
    expect(pick('', null, 'xyzzy').noMatches).toBe(true);
    expect(pick('', null, 'crown').noMatches).toBe(false);
    expect(pick('', null, '').noMatches).toBe(false);
  });
});

/* ===========================================================================
 * RULE 2 — NEVER SILENTLY DROP THE DENOMINATION THE COIN ALREADY HAS
 * (country-denomination-link.ts, and it was a real bug)
 * ======================================================================== */

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
    // Two options with the same value make the <select> highlight whichever
    // comes first, so the user can be looking at a different row from the
    // one the coin points at.
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
    // A <select> whose bound value has no matching <option> renders BLANK.
    // That is how the user comes to believe the field was emptied, and the
    // next thing they pick overwrites it for real. Typing in the search box
    // must not be able to cause that.
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
    // §4.4 nulls the id on deletion, so this should not happen -- but a
    // dangling id must produce no group rather than an undefined one.
    expect(pick('United States', 9999, '').groups.some((group) => group.current)).toBe(false);
  });
});

/* ===========================================================================
 * THE TYPE-AHEAD
 * ======================================================================== */

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
    // REUSES denomination-aliases.ts rather than carrying a second
    // vocabulary. 'Trime' and 'Three Cent Silver' fold onto the same key as
    // the seeded '3CS'. A second alias table here would be a second thing to
    // keep in step, and the editor and the migration would disagree about
    // what the same coin is the first time either was edited.
    //
    // `noMatches` IS CHECKED DELIBERATELY. Without it this test passes even
    // when the alias layer is not consulted at all: a query that matches
    // nothing falls back to the WHOLE list under Rule 1, and the whole list
    // contains '3CS'.
    for (const spelling of ['Three Cent Silver', 'Trime', 'three cent silver']) {
      const view = pick('', null, spelling);
      expect(view.noMatches, spelling).toBe(false);
      expect(labelsOf(view), spelling).toEqual(['3CS']);
    }
  });

  it('searches across every issuer, not just the coin country', () => {
    // The bias must not survive into the search. A US coin searching for
    // 'reales' has to find the Mexican row.
    const view = pick('United States', null, 'reales');
    expect(view.noMatches).toBe(false);
    expect(labelsOf(view)).toContain('8 Reales');
  });

  it('ranks the coin country first among the results', () => {
    // 'Crown' exists under Great Britain and Australia. A British coin
    // should see the British ones first -- that is the bias doing its job
    // inside the result list rather than outside it.
    const view = pick('Great Britain', null, 'crown');
    expect(view.groups[0].heading).toBe('Great Britain');
    expect(view.groups[0].preferred).toBe(true);
    expect(labelsOf(view)).toContain('Crown');
  });

  it('keeps both of two identically-labelled denominations, under their own issuers', () => {
    // 'Crown' is Australian AND British. Collapsing them by label would hide
    // one of them for good, and picking by label could not tell them apart
    // -- which is why the control carries ids, not labels.
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
    // The search box is a local UI signal and is not a coin field. Nothing
    // here returns an instruction to write; the test is that the function's
    // only product is a list.
    const view = pick('United States', MX_8_REALES.denominationId, 'crown');
    expect(Object.keys(view).sort()).toEqual(
      ['groups', 'matchCount', 'noMatches', 'query', 'shownCount', 'truncated']
    );
  });
});

/* ===========================================================================
 * PERFORMANCE — 1,161 ENTRIES AND A USER TYPING
 * ======================================================================== */

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
    // *** THE WHOLE PERFORMANCE ARGUMENT. ***
    // The expensive work -- resolving the coin's country against every
    // issuer through the seventy-odd patterns in coin-countries.ts, and
    // folding every label through the alias table -- happens here, in the
    // stage that does NOT depend on the query. The component holds it in its
    // own computed(), so a keystroke in the search box cannot re-run it.
    //
    // Identity, not deep equality: a fresh-but-equal object would mean the
    // work had been done again.
    const first = denominationPickerBase(BIG, 'United States', null);
    const second = denominationPickerBase(BIG, 'United States', null);
    expect(second).toBe(first);
  });

  it('rebuilds when something it actually depends on changes', () => {
    // A cache that never invalidates is worse than no cache. The coin's
    // country is the input the user can change while the list stays put.
    const base = denominationPickerBase(BIG, 'United States', null);
    expect(denominationPickerBase(BIG, 'Great Britain', null)).not.toBe(base);
    expect(denominationPickerBase(BIG, 'United States', 100000)).not.toBe(base);
    expect(denominationPickerBase([...BIG], 'United States', null)).not.toBe(base);
  });

  it('answers a whole typed word, keystroke by keystroke, in well under a frame each', () => {
    // 'Denom 7 of 13' typed one character at a time, twenty times over --
    // 260 filter passes across 1,159 entries. A budget of two seconds is
    // deliberately loose: it is here to catch an accidental per-keystroke
    // country resolution or alias fold (which is roughly two orders of
    // magnitude slower), not to measure the machine.
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
    // A one-character query matches hundreds of rows. Rendering all of them
    // on every keystroke is the thing that actually makes typing lag -- the
    // filter is cheap, the DOM is not. The cap is a RENDERING budget, not a
    // limit on the data: the counts below are what the control uses to tell
    // the user there is more and that typing will find it.
    const view = denominationPickerView(denominationPickerBase(BIG, '', null), 'Denom 1');

    expect(view.matchCount).toBeGreaterThan(MAX_PICKER_OPTIONS);
    expect(view.shownCount).toBe(MAX_PICKER_OPTIONS);
    expect(view.truncated).toBe(true);
    expect(labelsOf(view).length).toBe(MAX_PICKER_OPTIONS);
  });

  it('does NOT cap the unfiltered list — that would be a hard limit by the back door', () => {
    // With no query the list is rendered once, not per keystroke, so there
    // is nothing to budget for. Capping here would make the 201st issuer
    // unreachable by scrolling, which is exactly the "country hard-limits
    // the list" failure wearing a different hat.
    const view = denominationPickerView(denominationPickerBase(BIG, 'United States', null), '');

    expect(view.truncated).toBe(false);
    expect(labelsOf(view).length).toBe(BIG.length);
  });

  it('never lets the cap hide the denomination the coin already has', () => {
    // Rule 2 outranks the rendering budget. 'Denom 0 of 60' does not match
    // 'Denom 1' and belongs to an issuer the coin's country does not name,
    // so nothing but the rescue can put it on screen.
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

/* ===========================================================================
 * WHAT THE SELECT SITS ON, AND WHAT "OTHER" MEANS NOW
 * ======================================================================== */

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
    // The NORMAL state after migration 014 resolves a coin: the text still
    // says what the QIF said. The id is the authority (§4.1).
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

  /* -------------------------------------------------------------------------
   * TEXT WITH NO ID IS THE NORMAL OUTCOME OF AN IMPORT, NOT AN ODDITY.
   *
   * The picker cannot simply declare every id-less coin custom: on a database
   * that has not been migrated that is every coin, every denomination box in
   * the app would open as a free-text field, and the owner would conclude the
   * upgrade had destroyed his dropdown.
   *
   * It resolves the text first, through the SAME resolver the migration and
   * the importers use, and only calls it custom when that resolver cannot
   * name a single row. "Other" therefore means exactly one thing:
   *
   *     THE COIN'S TEXT NAMES NO SINGLE DENOMINATION WE CAN OFFER.
   *
   * Nothing is written while this happens. The select shows the resolved row
   * and the stored text is untouched until the user picks something.
   * ---------------------------------------------------------------------- */
  it('resolves the text for a coin the migration has not reached, and writes nothing', () => {
    const selection = denominationSelectionFor(null, '$1', 'United States', DENOMINATIONS);

    expect(selection.denominationId).toBe(US_DOLLAR.denominationId);
    expect(selection.label).toBe('$1');
    expect(selection.custom).toBe(false);
    expect(selection.source).toBe('resolved');
  });

  it('resolves through the alias table, so a Trime is not suddenly custom', () => {
    // "the 1866 3CS comes up showing Other" -- the bug denomination-aliases
    // was written for. It must not come back under a new picker.
    for (const spelling of ['3CS', 'Three Cent Silver', 'Trime', '3cs']) {
      const selection = denominationSelectionFor(null, spelling, 'United States', DENOMINATIONS);
      expect(selection.denominationId, spelling).toBe(US_3CS.denominationId);
      expect(selection.custom, spelling).toBe(false);
    }
  });

  it('resolves ACROSS issuers when the country names none — the 8 Reales case', () => {
    // Country = 'United States' and the only '8 Reales' on file is Mexican.
    // A country-scoped resolution would answer nothing here, and this is the
    // coin the refactor exists for.
    const selection = denominationSelectionFor(null, '8 Reales', 'United States', DENOMINATIONS);

    expect(selection.denominationId).toBe(MX_8_REALES.denominationId);
    expect(selection.source).toBe('resolved');
    expect(selection.custom).toBe(false);
  });

  it('refuses to guess between two issuers, and calls that custom', () => {
    // 'Crown' is Australian and British. Picking one would file the coin
    // under an issuer the owner never chose, invisibly and for good. The
    // custom box opens holding 'Crown', which is honest.
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
    // §4.4: the row is soft-deleted and the coin's id is nulled, leaving the
    // text. The picker must not resurrect the retired row.
    const selection = denominationSelectionFor(null, 'Half Cent', 'United States', DENOMINATIONS);
    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('is custom for a coin still pointing at a row that has been retired', () => {
    // Defensive: §4.4 nulls the id, but a hand-edited row or an older build
    // could leave one behind. Showing a retired row as the selected option
    // would offer the user something that is not in the list.
    const selection = denominationSelectionFor(
      RETIRED.denominationId, 'Half Cent', 'United States', DENOMINATIONS
    );
    expect(selection.denominationId).toBeNull();
    expect(selection.custom).toBe(true);
  });

  it('decides nothing at all before the lookup list has arrived', () => {
    // The denominations come from the server. Judged against an empty list
    // every coin looks unresolvable, so every box would flip to custom on
    // load and then flip back -- and CustomOptionMode only derives ONCE per
    // coin, so it would flip to custom and STAY there.
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

/* ===========================================================================
 * PICKING "Other"
 * ======================================================================== */

describe('customDenominationWrites — what picking Other saves', () => {
  const selectionFor = (id: number | null, text: string, country = 'United States') =>
    denominationSelectionFor(id, text, country, DENOMINATIONS);

  it('ALWAYS clears the link', () => {
    // A custom value has no id. Leaving the old one would make the coin go on
    // reading as the denomination the user has just rejected.
    const writes = customDenominationWrites(
      selectionFor(US_DOLLAR.denominationId, '$1'), '$1'
    );
    expect(writes[0]).toEqual({ field: 'denominationId', value: null });
  });

  it('clears it as null, never undefined', () => {
    // `undefined` is stripped from the patch before it is sent, so the column
    // would keep the stale id and nothing anywhere would say so.
    const writes = customDenominationWrites(selectionFor(US_DOLLAR.denominationId, '$1'), '$1');
    expect(writes[0].value).toBeNull();
    expect(writes[0].value).not.toBeUndefined();
  });

  it('clears the text when it is only a copy of the label being rejected', () => {
    // The state the picker itself creates: picking a denomination writes both
    // fields to the same thing. "It is none of these" must not leave '$1'
    // sitting in the box that has just opened.
    const writes = customDenominationWrites(selectionFor(US_DOLLAR.denominationId, '$1'), '$1');
    expect(writes).toContainEqual({ field: 'denomination', value: '' });
  });

  it('KEEPS imported text that disagrees with the link', () => {
    // A coin whose id says '8 Reales' while its text says 'Pillar Dollar' is
    // in the normal post-import state. That text is the ONLY surviving record
    // of what the QIF actually contained, and nothing rewrites it. Rejecting
    // the id is not a reason to destroy it.
    const writes = customDenominationWrites(
      selectionFor(MX_8_REALES.denominationId, 'Pillar Dollar'), 'Pillar Dollar'
    );
    expect(writes).toEqual([{ field: 'denominationId', value: null }]);
  });

  it('keeps the user’s own spelling of a denomination that merely resolved', () => {
    // 'Trime' resolves to '3CS' for display. The word is the user's, not the
    // app's, and nothing has been saved for it — so there is nothing here the
    // app is entitled to clear.
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
    // Country, in particular. Saying "it is none of these" is not a statement
    // about where the coin is from.
    for (const text of ['$1', 'Pillar Dollar', 'Trade Dollar', '']) {
      for (const write of customDenominationWrites(selectionFor(null, text), text)) {
        expect(['denominationId', 'denomination']).toContain(write.field);
      }
    }
  });
});

/* ===========================================================================
 * THE LABEL BEHIND AN ID — the input to denominationDisplay()
 * ======================================================================== */

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

/* ===========================================================================
 * THE OPTION VALUES THE <select> CARRIES
 * ======================================================================== */

describe('option values', () => {
  it('carries the id, not the label', () => {
    // 'Crown' is two different coins. A control keyed by label cannot write
    // the right id, and §4.1 requires the id to be written.
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
    // '__OTHER__' and '' are the two values that mean "not a denomination".
    // An id that stringified to either would be read as one of them.
    for (const group of pick('', null, '').groups) {
      for (const option of group.options) {
        expect(option.value).not.toBe('');
        expect(option.value).not.toBe('__OTHER__');
      }
    }
  });
});
