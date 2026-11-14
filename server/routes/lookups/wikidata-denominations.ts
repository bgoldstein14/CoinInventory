/*
 * routes/lookups/wikidata-denominations.ts — building and reading one
 * Wikidata query, with no network in sight.
 *
 * WHY WIKIDATA AND NOT ONE OF THE NUMISMATIC DATASETS
 *
 * The seed's own header records the survey: Nomisma is coin-TYPE data under
 * terms that are not plainly redistributable, Numista answers HTTP 403 to
 * automated reads, WorldCoinDatabase has no export. Wikidata is CC0, has a
 * public SPARQL endpoint, and is queried rather than scraped -- so what
 * comes back is a list of entities, not prose somebody has to parse.
 *
 * *** EXPECT TO FIND NOTHING, AND TREAT THAT AS NORMAL. ***
 * Measured against the live endpoint while this was written:
 *
 *     Japan     -> 9 candidates      Burma    -> 4
 *     Iceland   -> 1                 Parthia  -> 1
 *     Athens    -> 0                 (a nonsense string) -> 0
 *
 * Ancient coverage is thin and some of what does come back is not a
 * denomination at all ('Coin (reproduction)', 'leprosy colony money').
 * That is the whole reason nothing here writes to the database: the route
 * PROPOSES and the user confirms. A denomination is reference data that
 * coins link to by id, so a wrong row outlives the mistake that made it,
 * while an empty issuer costs one more typing session.
 *
 * WHY THE QUERY IS AS SMALL AS IT IS
 *
 * The obvious query -- match the typed name against every rdfs:label in
 * Wikidata, then walk wdt:P31/wdt:P279* to find anything that is a kind of
 * coin -- was written first and TIMED OUT at the endpoint (HTTP 504 after
 * 65 seconds) on names as ordinary as 'Burma'. Both halves were the
 * problem: an unbounded label scan, and an unbounded subclass walk.
 *
 * So the name is resolved by the endpoint's own entity search
 * (`wikibase:mwapi` / EntitySearch, the documented cheap way to do this) and
 * the classes are an explicit two-item VALUES list rather than a transitive
 * closure. The same six names then answer in 0.2 to 6 seconds.
 *
 * A consequence worth stating: EntitySearch does fuzzy matching, so a typo
 * usually returns nothing rather than a near-miss, and the user retries.
 * That is the agreed behaviour -- a typo is theirs to notice.
 *
 * Everything in this file is pure, so the query text and the parsing are
 * testable without a network, which is the half of this feature that can
 * actually be wrong in a quiet way.
 */

/** The public CC0 SPARQL endpoint. */
export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** What the UI calls the source when it says where a proposal came from. */
export const LOOKUP_SOURCE_NAME = 'Wikidata';

/**
 * A generic client name, with NO user, machine or install detail in it.
 *
 * Wikimedia asks automated clients to identify themselves. It does not ask
 * who is running them, and this application has no business telling an
 * outside service whose collection it holds.
 */
export const LOOKUP_USER_AGENT = 'CoinInventory/1.0 (offline coin collection manager)';

/**
 * `Denominations.Label` is NVARCHAR(100). A longer label is not a
 * denomination name, it is an article title that wandered in.
 */
export const MAX_PROPOSAL_LENGTH = 100;

/** How many proposals a user is asked to read at once. */
export const MAX_PROPOSALS = 40;

/** A SPARQL string literal. Backslash first, or the escaping eats itself. */
export function sparqlLiteral(value: string): string {
  return value.split('\\').join('\\\\').split('"').join('\\"');
}

/**
 * The query, for an issuer name the user typed.
 *
 * Q41207 is `coin` and Q8142 is `currency`; P17 is `country`. Items that
 * are an instance of either class and carry the matched entity as their
 * country are the two routes that actually return anything at a tolerable
 * cost. See the header for the larger query this replaced and why.
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

/**
 * An unlabelled Wikidata item.
 *
 * `SERVICE wikibase:label` falls back to the bare item id when there is no
 * English label, so 'Q4087051' comes back as if it were a denomination
 * name. It is not one, and it tells the user nothing they could judge.
 */
const BARE_ITEM_ID = /^Q\d+$/;

/**
 * Turn whatever the endpoint sent into a list a human can be asked about.
 *
 * Defensive to the point of paranoia about the shape, because the input is
 * a third party's JSON over a network: anything unexpected yields an empty
 * list, which lands on the same offline path as no network at all. There is
 * no shape of response that can make this throw.
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
 * Trim, drop what cannot be a denomination, de-duplicate, sort, cap.
 *
 * SORTED, and therefore deterministic. The endpoint does not promise an
 * order, and a list that comes back shuffled between two runs is a list the
 * user cannot re-check. Case-insensitive, because 'Kyat' and 'kyat' are one
 * proposal and offering both invites the user to accept both -- which is
 * exactly the duplicate-label-under-one-issuer collision that makes every
 * coin carrying that text resolve as ambiguous, and ambiguous resolves to
 * NULL.
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
