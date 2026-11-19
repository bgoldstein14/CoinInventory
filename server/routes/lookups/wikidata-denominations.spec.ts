/*
 * The Wikidata query text and response parsing, without a network. A query
 * matching nothing or a parser dropping everything would look like a lookup
 * that found nothing.
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
    // Backslash first, or the escaping breaks.
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
    // Not a security boundary (read-only public endpoint), but an unescaped
    // quote would break the query for a legal name.
    const query = buildDenominationQuery('Côte d"Ivoire');
    expect(query).toContain('mwapi:search "Côte d\\"Ivoire"');
  });

  it('asks the endpoint to resolve the name instead of scanning every label', () => {
    // A full label scan timed out (504 after 65 s); EntitySearch is the cheap route.
    const query = buildDenominationQuery('Burma');
    expect(query).toContain('SERVICE wikibase:mwapi');
    expect(query).toContain('bd:serviceParam wikibase:api "EntitySearch"');
    expect(query).not.toContain('rdfs:label ?issuerName');
  });

  it('names the two classes explicitly rather than walking the subclass tree', () => {
    // A transitive subclass walk is unbounded too.
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
    // Identifies the app only; no user, machine or path.
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
    // Any unexpected shape must mean "found nothing", never an exception.
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
    // Unlabelled items come back as their Q-number.
    expect(normaliseProposals(['Q4087051', 'kyat'])).toEqual(['kyat']);
  });

  it('keeps a name that merely starts with a Q', () => {
    expect(normaliseProposals(['Quarter Shekel', 'Q12'])).toEqual(['Quarter Shekel']);
  });

  it('folds two spellings of one coin into one proposal', () => {
    // Case variants are one proposal; duplicates under one issuer make resolution ambiguous.
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
