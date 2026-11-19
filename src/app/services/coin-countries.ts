 /*
  * Reads a country and a foreign denomination from a Quicken security name, and
  * bridges country codes and names across the app.
  *
  *     detectCountry("1969 Peru 100 Soles - NGC MS64")             -> "Peru"
  *     detectForeignDenomination("1969 Peru 100 Soles - NGC MS64") -> "100 Soles"
  *
  * Both return '' when unsure; the caller then leaves the field alone. Without
  * them a name like that parses with only a Year and fails the 2-of-3 rule.
  *
  * Like image-matching/denomination-units.ts (US face values in filenames), a
  * number counts as a denomination only when bound to a currency unit, but this
  * file covers world coinage.
  *
  * Units with a single issuer may imply the country ("Soles" is Peru). Shared
  * units ("20 Francs", "50 Pesos") give the denomination but leave the country
  * blank unless the name states it, since a wrong country would attach the
  * wrong melt reference.
  */

/** A country the parser can recognise by name. */
interface CountryEntry {
  /**
   * Canonical spelling written into the record. Must match the `country` values
   * in pm-reference.ts, or the precious-metal lookup would silently fail.
   */
  canonical: string;
  /**
   * Two-letter ISO code for this country. Denominations.Country stores codes
   * ('US', 'GB') while Coins.Country stores full names ('United States'), so the
   * two are compared through `resolveCountryName()`. This table is the only
   * place that mapping lives. Optional: e.g. 'Scotland' has no alpha-2 code.
   */
  code?: string;
  /**
   * Whole-word, case-insensitive patterns naming this country, so "India" can't
   * match inside "Indian Head".
   */
  patterns: readonly RegExp[];
}

 /*
  * Country vocabulary. Entries that could appear in a US coin's name are guarded:
  *   "Panama"   not followed by "Pacific" (1915-S Panama-Pacific commemoratives)
  *   "Spanish"  not followed by "Trail" (1935 Old Spanish Trail half dollar)
  *   "India"    whole word only ("Indian Head", "Indian Princess" are US types)
  *   "Colombia" spelled with an 'o'; the US "Columbian" Exposition half is safe
  *   "Guinea"   omitted: the Guinea is an English gold coin
  */
const COUNTRIES: readonly CountryEntry[] = [
  // The Americas
  { canonical: 'United States', code: 'US', patterns: [/\bunited\s+states\b/i, /\bu\.?s\.?a\.?\b/i, /\bamerican?\b/i] },
  { canonical: 'Canada', code: 'CA', patterns: [/\bcanad(?:a|ian)\b/i] },
  { canonical: 'Mexico', code: 'MX', patterns: [/\bmexic(?:o|an)\b/i] },
  { canonical: 'Peru', code: 'PE', patterns: [/\bperu(?:vian)?\b/i] },
  { canonical: 'Brazil', code: 'BR', patterns: [/\bbrazil(?:ian)?\b/i, /\bbrasil\b/i] },
  { canonical: 'Argentina', code: 'AR', patterns: [/\bargentin(?:a|e|ian)\b/i] },
  { canonical: 'Chile', code: 'CL', patterns: [/\bchile(?:an)?\b/i] },
  { canonical: 'Colombia', code: 'CO', patterns: [/\bcolombian?\b/i] },
  { canonical: 'Venezuela', code: 'VE', patterns: [/\bvenezuelan?\b/i] },
  { canonical: 'Bolivia', code: 'BO', patterns: [/\bbolivian?\b/i] },
  { canonical: 'Ecuador', code: 'EC', patterns: [/\becuador(?:ian)?\b/i] },
  { canonical: 'Uruguay', code: 'UY', patterns: [/\buruguay(?:an)?\b/i] },
  { canonical: 'Paraguay', code: 'PY', patterns: [/\bparaguay(?:an)?\b/i] },
  { canonical: 'Cuba', code: 'CU', patterns: [/\bcuban?\b/i] },
  { canonical: 'Guatemala', code: 'GT', patterns: [/\bguatemalan?\b/i] },
  { canonical: 'Costa Rica', code: 'CR', patterns: [/\bcosta\s+rica(?:n)?\b/i] },
  // "Panama-Pacific" is a US commemorative series.
  { canonical: 'Panama', code: 'PA', patterns: [/\bpanama\b(?!\s*[-–]?\s*pacific)/i] },
  { canonical: 'Nicaragua', code: 'NI', patterns: [/\bnicaraguan?\b/i] },
  { canonical: 'Honduras', code: 'HN', patterns: [/\bhondura(?:s|n)\b/i] },
  { canonical: 'Dominican Republic', code: 'DO', patterns: [/\bdominican\b/i] },
  { canonical: 'Haiti', code: 'HT', patterns: [/\bhaiti(?:an)?\b/i] },

  // Europe. "Great Britain" is canonical because pm-reference.ts uses it.
  {
    canonical: 'Great Britain', code: 'GB',
    patterns: [/\bgreat\s+britain\b/i, /\bbritain\b/i, /\bbritish\b/i, /\bengl(?:and|ish)\b/i, /\bunited\s+kingdom\b/i, /\bu\.?k\.?\b/i]
  },
  { canonical: 'Scotland', patterns: [/\bscot(?:land|tish)\b/i] },
  { canonical: 'Ireland', code: 'IE', patterns: [/\birish\b/i, /\bireland\b/i] },
  { canonical: 'France', code: 'FR', patterns: [/\bfrance\b/i, /\bfrench\b/i] },
  { canonical: 'Germany', code: 'DE', patterns: [/\bgerman(?:y)?\b/i, /\bprussian?\b/i, /\bbavarian?\b/i, /\bsaxony\b/i] },
  { canonical: 'Austria', code: 'AT', patterns: [/\baustria(?:n)?\b/i, /\baustro[-\s]?hungar(?:y|ian)\b/i] },
  { canonical: 'Switzerland', code: 'CH', patterns: [/\bswitzerland\b/i, /\bswiss\b/i, /\bhelvetia\b/i] },
  { canonical: 'Netherlands', code: 'NL', patterns: [/\bnetherlands\b/i, /\bholland\b/i, /\bdutch\b/i] },
  { canonical: 'Belgium', code: 'BE', patterns: [/\bbelgi(?:um|an)\b/i] },
  { canonical: 'Italy', code: 'IT', patterns: [/\bital(?:y|ian)\b/i] },
  { canonical: 'Vatican', code: 'VA', patterns: [/\bvatican\b/i] },
  { canonical: 'Spain', code: 'ES', patterns: [/\bspain\b/i, /\bespa(?:n|ñ)a\b/i, /\bspanish\b(?!\s+trail)/i] },
  { canonical: 'Portugal', code: 'PT', patterns: [/\bportug(?:al|uese)\b/i] },
  { canonical: 'Russia', code: 'RU', patterns: [/\brussia(?:n)?\b/i, /\bussr\b/i, /\bsoviet\b/i] },
  { canonical: 'Poland', code: 'PL', patterns: [/\bpol(?:and|ish)\b/i] },
  { canonical: 'Hungary', code: 'HU', patterns: [/\bhungar(?:y|ian)\b/i] },
  { canonical: 'Czechoslovakia', code: 'CS', patterns: [/\bczech(?:oslovakia)?\b/i] },
  { canonical: 'Yugoslavia', code: 'YU', patterns: [/\byugoslavian?\b/i] },
  { canonical: 'Serbia', code: 'RS', patterns: [/\bserbian?\b/i] },
  { canonical: 'Romania', code: 'RO', patterns: [/\broumania\b/i, /\bromanian?\b/i] },
  { canonical: 'Bulgaria', code: 'BG', patterns: [/\bbulgarian?\b/i] },
  { canonical: 'Greece', code: 'GR', patterns: [/\bgree(?:ce|k)\b/i] },
  { canonical: 'Sweden', code: 'SE', patterns: [/\bswed(?:en|ish)\b/i] },
  { canonical: 'Norway', code: 'NO', patterns: [/\bnorw(?:ay|egian)\b/i] },
  { canonical: 'Denmark', code: 'DK', patterns: [/\bden(?:mark)\b/i, /\bdanish\b/i] },
  { canonical: 'Finland', code: 'FI', patterns: [/\bfin(?:land|nish)\b/i] },
  { canonical: 'Iceland', code: 'IS', patterns: [/\biceland(?:ic)?\b/i] },
  { canonical: 'Turkey', code: 'TR', patterns: [/\bturk(?:ey|ish)\b/i, /\bottoman\b/i] },

  // Africa and the Middle East
  { canonical: 'South Africa', code: 'ZA', patterns: [/\bsouth\s+africa(?:n)?\b/i, /\bkrugerrand\b/i, /\btransvaal\b/i] },
  { canonical: 'Egypt', code: 'EG', patterns: [/\begypt(?:ian)?\b/i] },
  { canonical: 'Morocco', code: 'MA', patterns: [/\bmorocc(?:o|an)\b/i] },
  { canonical: 'Tunisia', code: 'TN', patterns: [/\btunisian?\b/i] },
  { canonical: 'Israel', code: 'IL', patterns: [/\bisrael(?:i)?\b/i] },
  { canonical: 'Saudi Arabia', code: 'SA', patterns: [/\bsaudi(?:\s+arabia)?\b/i] },
  { canonical: 'Iran', code: 'IR', patterns: [/\biran(?:ian)?\b/i, /\bpersian?\b/i] },
  { canonical: 'Ethiopia', code: 'ET', patterns: [/\bethiopian?\b/i] },
  { canonical: 'Nigeria', code: 'NG', patterns: [/\bnigerian?\b/i] },
  { canonical: 'Kenya', code: 'KE', patterns: [/\bkenyan?\b/i] },

  // Asia and Oceania
  { canonical: 'China', code: 'CN', patterns: [/\bchin(?:a|ese)\b/i] },
  { canonical: 'Japan', code: 'JP', patterns: [/\bjapan(?:ese)?\b/i] },
  { canonical: 'Korea', code: 'KR', patterns: [/\bkorean?\b/i] },
  // Whole word only: "Indian Head" and "Indian Princess" are US coin types.
  { canonical: 'India', code: 'IN', patterns: [/\bindia\b/i] },
  { canonical: 'Thailand', code: 'TH', patterns: [/\bthailand\b/i, /\bsiam(?:ese)?\b/i] },
  { canonical: 'Vietnam', code: 'VN', patterns: [/\bviet\s?nam(?:ese)?\b/i] },
  { canonical: 'Indonesia', code: 'ID', patterns: [/\bindonesian?\b/i] },
  { canonical: 'Philippines', code: 'PH', patterns: [/\bphilippines?\b/i, /\bfilipino\b/i] },
  { canonical: 'Hong Kong', code: 'HK', patterns: [/\bhong\s?kong\b/i] },
  { canonical: 'Singapore', code: 'SG', patterns: [/\bsingapore(?:an)?\b/i] },
  { canonical: 'Malaysia', code: 'MY', patterns: [/\bmalaysian?\b/i] },
  { canonical: 'Australia', code: 'AU', patterns: [/\baustralian?\b/i] },
  { canonical: 'New Zealand', code: 'NZ', patterns: [/\bnew\s+zealand\b/i] }
];

 /*
  * Currency-unit vocabulary. `singular`/`plural` are accepted spellings;
  * `canonical` is written to the Denomination field ("100 SOLES" -> "100 Soles").
  * `impliesCountry` is set only for units with one issuer; shared units (Peso,
  * Franc, Mark, Pound, Dinar, Krona, Rupee, Escudo, Lira, Ducat, Real, Crown,
  * Dollar) leave it undefined.
  */
interface CurrencyUnit {
  canonical: string;
  singular: string;
  plural?: string;
  /** Extra spellings, e.g. "Soles" is itself the plural of "Sol". */
  aliases?: readonly string[];
  /** Set only when this unit has a single issuer. */
  impliesCountry?: string;
}

const CURRENCY_UNITS: readonly CurrencyUnit[] = [
  // Units that name their own country
  { canonical: 'Soles', singular: 'sol', plural: 'soles', impliesCountry: 'Peru' },
  { canonical: 'Bolivares', singular: 'bolivar', plural: 'bolivares', impliesCountry: 'Venezuela' },
  { canonical: 'Bolivianos', singular: 'boliviano', plural: 'bolivianos', impliesCountry: 'Bolivia' },
  { canonical: 'Quetzales', singular: 'quetzal', plural: 'quetzales', impliesCountry: 'Guatemala' },
  { canonical: 'Balboas', singular: 'balboa', plural: 'balboas', impliesCountry: 'Panama' },
  { canonical: 'Colones', singular: 'colon', plural: 'colones', impliesCountry: 'Costa Rica' },
  { canonical: 'Cordobas', singular: 'cordoba', plural: 'cordobas', impliesCountry: 'Nicaragua' },
  { canonical: 'Lempiras', singular: 'lempira', plural: 'lempiras', impliesCountry: 'Honduras' },
  { canonical: 'Guaranies', singular: 'guarani', plural: 'guaranies', impliesCountry: 'Paraguay' },
  { canonical: 'Rand', singular: 'rand', impliesCountry: 'South Africa' },
  // The "Kruger pond" of the old South African Republic; nobody else struck one.
  // The number-binding rule keeps the English word "pond" from matching alone.
  { canonical: 'Pond', singular: 'pond', plural: 'ponde', impliesCountry: 'South Africa' },
  { canonical: 'Forint', singular: 'forint', impliesCountry: 'Hungary' },
  { canonical: 'Zlotych', singular: 'zloty', plural: 'zlotych', aliases: ['zlote'], impliesCountry: 'Poland' },
  { canonical: 'Drachmai', singular: 'drachma', plural: 'drachmai', aliases: ['drachmas'], impliesCountry: 'Greece' },
  { canonical: 'Leva', singular: 'lev', plural: 'leva', impliesCountry: 'Bulgaria' },
  { canonical: 'Yen', singular: 'yen', impliesCountry: 'Japan' },
  { canonical: 'Yuan', singular: 'yuan', impliesCountry: 'China' },
  { canonical: 'Won', singular: 'won', impliesCountry: 'Korea' },
  { canonical: 'Baht', singular: 'baht', aliases: ['tical'], impliesCountry: 'Thailand' },
  { canonical: 'Rupiah', singular: 'rupiah', impliesCountry: 'Indonesia' },
  { canonical: 'Ringgit', singular: 'ringgit', impliesCountry: 'Malaysia' },
  { canonical: 'Roubles', singular: 'rouble', plural: 'roubles', aliases: ['ruble', 'rubles'], impliesCountry: 'Russia' },
  { canonical: 'Pesetas', singular: 'peseta', plural: 'pesetas', impliesCountry: 'Spain' },
  { canonical: 'Gulden', singular: 'gulden', aliases: ['guilder', 'guilders'], impliesCountry: 'Netherlands' },
  { canonical: 'Corona', singular: 'corona', plural: 'coronas', aliases: ['korona', 'kronen'], impliesCountry: 'Austria' },
  { canonical: 'Piastres', singular: 'piastre', plural: 'piastres', aliases: ['piaster', 'piasters'] },

  // Units shared by several issuers: denomination only, no country
  { canonical: 'Pesos', singular: 'peso', plural: 'pesos' },
  { canonical: 'Francs', singular: 'franc', plural: 'francs' },
  { canonical: 'Marks', singular: 'mark', plural: 'marks', aliases: ['marc', 'marcos'] },
  { canonical: 'Lire', singular: 'lira', plural: 'lire', aliases: ['liras'] },
  { canonical: 'Escudos', singular: 'escudo', plural: 'escudos' },
  { canonical: 'Reis', singular: 'reis', aliases: ['reais'] },
  { canonical: 'Rupees', singular: 'rupee', plural: 'rupees' },
  { canonical: 'Kronor', singular: 'krona', plural: 'kronor' },
  { canonical: 'Kroner', singular: 'krone', plural: 'kroner' },
  { canonical: 'Dinars', singular: 'dinar', plural: 'dinars' },
  { canonical: 'Dirhams', singular: 'dirham', plural: 'dirhams' },
  { canonical: 'Riyals', singular: 'riyal', plural: 'riyals', aliases: ['rial', 'rials'] },
  { canonical: 'Lei', singular: 'leu', plural: 'lei' },
  { canonical: 'Dong', singular: 'dong' },
  { canonical: 'Centavos', singular: 'centavo', plural: 'centavos' },
  { canonical: 'Centimes', singular: 'centime', plural: 'centimes' },
  { canonical: 'Pfennig', singular: 'pfennig', plural: 'pfennige' },
  { canonical: 'Kopeks', singular: 'kopek', plural: 'kopeks', aliases: ['kopeck', 'kopecks'] },
  { canonical: 'Ducats', singular: 'ducat', plural: 'ducats' },
  // No impliesCountry: many states issue euros. The country comes from the name
  // itself when stated (e.g. "2025 Italy 50 Euro").
  { canonical: 'Euro', singular: 'euro', plural: 'euro', aliases: ['euros'] }
];

/** Every accepted spelling, longest first so "soles" beats "sol". */
const UNIT_SPELLINGS: readonly { spelling: string; unit: CurrencyUnit }[] = CURRENCY_UNITS
  .flatMap((unit) => {
    const spellings = new Set<string>([unit.singular, unit.plural ?? '', ...(unit.aliases ?? [])]);
    spellings.delete('');
    return [...spellings].map((spelling) => ({ spelling, unit }));
  })
  .sort((left, right) => right.spelling.length - left.spelling.length);

/**
 * `100 Soles`, `20 francs`, `8 Reales`: up to four digits (e.g. "5000 Lei"),
 * then whitespace or a hyphen, then a known unit.
 * The leading `(?:^|[^\w$¢£.])` guard stops it matching the tail of a year
 * ("1969"), a US "$20", or a price like "2.50 Pesos".
 */
const NUMBER_AND_UNIT = new RegExp(
  `(?:^|[^\\w$¢£.])(\\d{1,4})[\\s-]+(${UNIT_SPELLINGS.map((entry) => entry.spelling).join('|')})\\b`,
  'i'
);

/** What `detectForeignDenomination` found, if anything. */
export interface ForeignDenomination {
  /** Normalised denomination for the record, e.g. "100 Soles". */
  denomination: string;
  /** The country this unit proves, or '' when several issuers share it. */
  impliedCountry: string;
}

/**
 * Reads a `<number> <foreign currency unit>` denomination from a security name.
 * Returns null when there is none (the usual case: most coins are US).
 */
export function detectForeignDenomination(securityName: string): ForeignDenomination | null {
  const text = String(securityName ?? '');
  const match = NUMBER_AND_UNIT.exec(text);
  if (!match) return null;

  const quantity = match[1];
  const spelling = match[2].toLowerCase();
  const hit = UNIT_SPELLINGS.find((entry) => entry.spelling === spelling);
  if (!hit) return null;

  // A quantity of 1 uses the singular ("1 Ducat").
  const unitText =
    quantity === '1'
      ? hit.unit.singular.charAt(0).toUpperCase() + hit.unit.singular.slice(1)
      : hit.unit.canonical;

  return {
    denomination: `${quantity} ${unitText}`,
    impliedCountry: hit.unit.impliesCountry ?? ''
  };
}

/**
 * Reads a country from a security name: a country named in the text first,
 * otherwise a currency unit with a single issuer ("100 Soles" -> Peru).
 * Returns '' when neither applies; the QIF importer then defaults to "United States".
 */
export function detectCountry(securityName: string): string {
  const text = String(securityName ?? '');
  if (!text.trim()) return '';

  for (const entry of COUNTRIES) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.canonical;
    }
  }

  const foreign = detectForeignDenomination(text);
  return foreign?.impliedCountry ?? '';
}

/*
 * Code <-> name bridge. Denominations store codes ('GB'), coins store names
 * ('Great Britain'). Both sides go through `resolveCountryName()` and the
 * canonical names are compared. This also tolerates free text: 'GB', 'uk',
 * 'British', 'United Kingdom' all resolve to 'Great Britain'.
 */

/** Code (upper-cased) -> canonical name. */
const CANONICAL_BY_CODE: ReadonlyMap<string, string> = new Map(
  COUNTRIES.filter((entry) => entry.code).map((entry) => [entry.code!.toUpperCase(), entry.canonical])
);

/** Lower-cased canonical name -> canonical name, for an exact-spelling hit. */
const CANONICAL_BY_NAME: ReadonlyMap<string, string> = new Map(
  COUNTRIES.map((entry) => [entry.canonical.toLowerCase(), entry.canonical])
);

/**
 * Resolves any country spelling to one canonical name. Checked in order:
 *   1. the canonical name itself   'Great Britain', 'great britain'
 *   2. a two-letter code           'GB', 'gb', 'US' (the prose patterns don't match bare codes)
 *   3. the name patterns           'UK', 'British', 'England'
 * Returns '' when unknown; callers must treat that as "no opinion" and show
 * everything rather than filter to nothing.
 */
export function resolveCountryName(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const exact = CANONICAL_BY_NAME.get(text.toLowerCase());
  if (exact) return exact;

  if (/^[A-Za-z]{2}$/.test(text)) {
    const byCode = CANONICAL_BY_CODE.get(text.toUpperCase());
    if (byCode) return byCode;
  }

  for (const entry of COUNTRIES) {
    if (entry.patterns.some((pattern) => pattern.test(text))) {
      return entry.canonical;
    }
  }

  return '';
}

/**
 * Whether two spellings mean the same country ('GB' equals 'Great Britain').
 * If neither resolves they are compared as plain text, so an unknown code still
 * groups with itself; if only one resolves they differ.
 */
export function isSameCountry(left: string | null | undefined, right: string | null | undefined): boolean {
  const leftText = String(left ?? '').trim();
  const rightText = String(right ?? '').trim();
  if (!leftText || !rightText) return false;

  const leftCanonical = resolveCountryName(leftText);
  const rightCanonical = resolveCountryName(rightText);

  if (leftCanonical && rightCanonical) return leftCanonical === rightCanonical;
  if (leftCanonical || rightCanonical) return false;

  return leftText.toLowerCase() === rightText.toLowerCase();
}

/** Display form: 'GB' becomes 'Great Britain'; unrecognised values are returned as stored. */
export function countryDisplayName(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  return resolveCountryName(text) || text;
}

/** Every canonical country name, sorted; suggestions for the Country box's <datalist>. */
export function allCountryNames(): string[] {
  return COUNTRIES.map((entry) => entry.canonical).sort((left, right) => left.localeCompare(right));
}
