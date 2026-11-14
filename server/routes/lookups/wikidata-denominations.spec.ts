/*
 * routes/lookups/wikidata-denominations.spec.ts
 *
 * The query text and the parsing, with no network. These are the two halves
 * of the lookup that can be wrong QUIETLY: a query that silently matches
 * nothing and a parser that silently drops everything look identical from
 * the outside to a lookup that correctly found nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  LOOKUP_USER_AGENT,
  MAX_PROPOSALS,
  MAX_PROPOSAL_LENGTH,
  WIKIDATA_SPARQL_ENDPOINT,
  buildDenominationQuery,
  buildDenominationQueryUrl,
  normaliseProposals,
  parseDenominationResults,
  sparqlLiteral,
} from './wikidata-denominations';

/** A SPARQL JSON result set carrying these labels. */
function resultsFor(labels: string[]): unknown {
  return {
    head: { vars: ['denominationLabel'] },
    results: {
      bindings: labels.map((value) => ({ denominationLabel: { type: 'literal', value } })),
    },
  };
}

describe('sparqlLiteral', () => {
  it('escapes the backslash before the quote', () => {
    // The other order turns one backslash into an escaped quote and the
    // query stops parsing where the author did not intend.
    expect(sparqlLiteral('a\\b')).toBe('a\\\\b');
    expect(sparqlLiteral('He said "no"')).toBe('He said \\"no\\"');
    expect(sparqlLiteral('back\\"slash')).toBe('back\\\\\\"slash');
  });
});

describe('buildDenominationQuery', () => {
  it('puts the typed name into the entity search, trimmed', () => {
    const query = buildDenominationQuery('  Burma  ');
    expect(query).toContain('bd:serviceParam mwapi:search "Burma" .');
  });

  it('cannot be broken out of by a name with a quote in it', () => {
    // Not a security boundary -- the endpoint is read-only and public --
    // but an unescaped quote makes the query fail to parse, which would
    // reach the user as "the lookup is broken" for a legal issuer name.
    const query = buildDenominationQuery('Côte d"Ivoire');
    expect(query).toContain('mwapi:search "Côte d\\"Ivoire"');
  });

  it('asks the endpoint to resolve the name instead of scanning every label', () => {
    // THE REASON THIS SHAPE EXISTS. Matching the typed name against every
    // rdfs:label in Wikidata timed the endpoint out (HTTP 504 after 65s)
    // on 'Burma'. EntitySearch is the documented cheap route.
    const query = buildDenominationQuery('Burma');
    expect(query).toContain('SERVICE wikibase:mwapi');
    expect(query).toContain('bd:serviceParam wikibase:api "EntitySearch"');
    expect(query).not.toContain('rdfs:label ?issuerName');
  });

  it('names the two classes explicitly rather than walking the subclass tree', () => {
    // The other half of the timeout. wdt:P31/wdt:P279* is unbounded.
    const query = buildDenominationQuery('Burma');
    expect(query).toContain('VALUES ?class { wd:Q41207 wd:Q8142 }');
    expect(query).not.toContain('wdt:P279*');
  });

  it('bounds the result set', () => {
    expect(buildDenominationQuery('Burma')).toMatch(/LIMIT \d+/);
  });
});

describe('buildDenominationQueryUrl', () => {
  it('asks for JSON from the CC0 endpoint, with the query encoded', () => {
    const url = buildDenominationQueryUrl('Burma');
    expect(url.startsWith(`${WIKIDATA_SPARQL_ENDPOINT}?format=json&query=`)).toBe(true);

    const query = decodeURIComponent(url.split('&query=')[1]);
    expect(query).toBe(buildDenominationQuery('Burma'));
  });
});

describe('the user agent', () => {
  it('identifies the application and says nothing about who is running it', () => {
    // Wikimedia asks automated clients to identify themselves. It does not
    // ask whose coin collection this is, and the app must not volunteer a
    // user name, a machine name or an install path.
    expect(LOOKUP_USER_AGENT).toContain('CoinInventory');
    expect(LOOKUP_USER_AGENT).not.toMatch(/@/);
    expect(LOOKUP_USER_AGENT.toLowerCase()).not.toContain('user');
    expect(LOOKUP_USER_AGENT).not.toMatch(/[A-Za-z]:\\/);
  });
});

describe('parseDenominationResults', () => {
  it('reads the labels out of a real-shaped result set', () => {
    expect(parseDenominationResults(resultsFor(['kyat', 'Burmese rupee']))).toEqual(['Burmese rupee', 'kyat']);
  });

  it('returns nothing rather than throwing for any shape at all', () => {
    // The input is a third party's JSON over a network. Every one of these
    // must land on the same path as "found nothing", because an exception
    // here would become an error dialog for the commonest outcome.
    for (const payload of [null, undefined, 42, 'text', {}, { results: {} }, { results: { bindings: 'no' } }, []]) {
      expect(parseDenominationResults(payload), JSON.stringify(payload) ?? 'undefined').toEqual([]);
    }
  });

  it('ignores a binding that has no label', () => {
    const payload = { results: { bindings: [{}, { denominationLabel: {} }, { denominationLabel: { value: 'kyat' } }] } };
    expect(parseDenominationResults(payload)).toEqual(['kyat']);
  });
});

describe('normaliseProposals', () => {
  it('drops the bare item id an unlabelled entity comes back as', () => {
    // SERVICE wikibase:label falls back to the Q-number when there is no
    // English label, so 'Q4087051' arrives looking like a denomination.
    // It was in the real answer for 'Burma'.
    expect(normaliseProposals(['Q4087051', 'kyat'])).toEqual(['kyat']);
  });

  it('keeps a name that merely starts with a Q', () => {
    expect(normaliseProposals(['Quarter Shekel', 'Q12'])).toEqual(['Quarter Shekel']);
  });

  it('folds two spellings of one coin into one proposal', () => {
    // Offering both invites the user to accept both, and two rows with the
    // same label under one issuer make every coin carrying that text
    // resolve as AMBIGUOUS -- which resolves to NULL. The duplicate would
    // not add a denomination, it would take one away.
    expect(normaliseProposals(['Kyat', 'kyat', 'KYAT'])).toEqual(['Kyat']);
  });

  it('collapses runs of whitespace before comparing', () => {
    expect(normaliseProposals(['8  Reales', '8 Reales'])).toEqual(['8 Reales']);
  });

  it('refuses anything too long for Denominations.Label', () => {
    const tooLong = 'x'.repeat(MAX_PROPOSAL_LENGTH + 1);
    expect(normaliseProposals([tooLong, 'x'.repeat(MAX_PROPOSAL_LENGTH)])).toEqual([
      'x'.repeat(MAX_PROPOSAL_LENGTH),
    ]);
  });

  it('drops blanks', () => {
    expect(normaliseProposals(['', '   ', 'kyat'])).toEqual(['kyat']);
  });

  it('sorts, so two runs of the same lookup read the same way', () => {
    expect(normaliseProposals(['pya', 'kyat', 'Burmese rupee'])).toEqual(['Burmese rupee', 'kyat', 'pya']);
  });

  it('caps the list at a number a person will actually read', () => {
    const many = Array.from({ length: MAX_PROPOSALS + 25 }, (_unused, index) => `coin ${String(index).padStart(3, '0')}`);
    expect(normaliseProposals(many)).toHaveLength(MAX_PROPOSALS);
  });
});
