/*
 * Builds the Wikidata query for an issuer's denominations and parses the
 * response. Pure functions, so they can be tested without a network.
 *
 * Wikidata is used because it is CC0 with a public SPARQL endpoint (Nomisma's
 * terms aren't clearly redistributable, Numista blocks automated reads).
 * Expect few or no results, especially for ancients, and some noise; results
 * are only proposals the user confirms.
 *
 * The query uses EntitySearch to resolve the name and a fixed two-class VALUES
 * list, because a label scan plus a transitive subclass walk timed out (504
 * after 65 s). EntitySearch is not fuzzy, so a typo usually returns nothing.
 */

/** The public CC0 SPARQL endpoint. */
export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** What the UI calls the source when it says where a proposal came from. */
export const LOOKUP_SOURCE_NAME = 'Wikidata';

/**
 * A generic client name with no user, machine or install detail. Wikimedia
 * asks automated clients to identify themselves, not who runs them.
 */
export const LOOKUP_USER_AGENT = 'CoinInventory/1.0 (offline coin collection manager)';

/** Denominations.Label is NVARCHAR(100); anything longer isn't a denomination name. */
export const MAX_PROPOSAL_LENGTH = 100;

/** How many proposals a user is asked to read at once. */
export const MAX_PROPOSALS = 40;

/** A SPARQL string literal. Backslash first, or the escaping eats itself. */
export function sparqlLiteral(value: string): string {
  return value.split('\\').join('\\\\').split('"').join('\\"');
}

/**
 * The query for an issuer name. Q41207 is `coin`, Q8142 is `currency`, P17
 * is `country`: items of either class whose country is the matched entity.
 */
export function buildDenominationQuery(issuerName: string): string {
  const name = sparqlLiteral(issuerName.trim());

  return [
    'SELECT DISTINCT ?denominationLabel WHERE {',
    '  SERVICE wikibase:mwapi {',
    '    bd:serviceParam wikibase:api "EntitySearch" .',
    '    bd:serviceParam wikibase:endpoint "www.wikidata.org" .',
    `    bd:serviceParam mwapi:search "${name}" .`,
    '    bd:serviceParam mwapi:language "en" .',
    '    bd:serviceParam mwapi:limit "2" .',
    '    ?issuer wikibase:apiOutputItem mwapi:item .',
    '  }',
    '  VALUES ?class { wd:Q41207 wd:Q8142 }',
    '  ?denomination wdt:P31 ?class ; wdt:P17 ?issuer .',
    '  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }',
    '}',
    `LIMIT ${MAX_PROPOSALS + 10}`,
  ].join('\n');
}

/** The GET url for that query. */
export function buildDenominationQueryUrl(issuerName: string): string {
  const query = encodeURIComponent(buildDenominationQuery(issuerName));
  return `${WIKIDATA_SPARQL_ENDPOINT}?format=json&query=${query}`;
}

/** An unlabelled item: the label service falls back to the bare id (e.g. 'Q4087051'). */
const BARE_ITEM_ID = /^Q\d+$/;

/**
 * Turns the endpoint's JSON into a list of proposals. Any unexpected shape
 * yields an empty list; it never throws.
 */
export function parseDenominationResults(payload: unknown): string[] {
  const bindings = (payload as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) return [];

  const labels: string[] = [];
  for (const binding of bindings) {
    const value = (binding as Record<string, { value?: unknown }> | null)?.['denominationLabel']?.value;
    if (typeof value === 'string') labels.push(value);
  }

  return normaliseProposals(labels);
}

/**
 * Trim, drop non-denominations, de-duplicate (case-insensitively) and sort,
 * then cap. Sorting makes results deterministic; case-insensitive dedup
 * avoids offering 'Kyat' and 'kyat' as two denominations.
 */
export function normaliseProposals(labels: readonly string[]): string[] {
  const bySpelling = new Map<string, string>();

  for (const raw of labels) {
    const label = raw.trim().replace(/\s+/g, ' ');
    if (label.length === 0) continue;
    if (label.length > MAX_PROPOSAL_LENGTH) continue;
    if (BARE_ITEM_ID.test(label)) continue;

    const folded = label.toLowerCase();
    if (!bySpelling.has(folded)) bySpelling.set(folded, label);
  }

  return [...bySpelling.values()]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .slice(0, MAX_PROPOSALS);
}
