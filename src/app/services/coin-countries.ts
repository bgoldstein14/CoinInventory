/* ===========================================================================
 * coin-countries.ts — WHICH COUNTRY IS THIS, AND WHAT IS ITS DENOMINATION?
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Two readings taken from a Quicken security name:
 *
 *     detectCountry("1969 Peru 100 Soles - NGC MS64")      -> "Peru"
 *     detectForeignDenomination("1969 Peru 100 Soles ...")  -> "100 Soles"
 *
 *   Both return '' when they cannot tell, and the caller is expected to leave
 *   the field alone rather than invent something.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The QIF parser used to hard-code `country: 'United States'` for every row,
 * and its denomination table only understood US face values ("$20", "50c",
 * "Dollar"). That is fine for 43 of the 44 coins in this collection and wrong
 * for the 44th:
 *
 *     Y1969 Peru 100 Soles - NGC MS64
 *
 * It parsed with a Year and nothing else, failed the 2-of-3 completeness rule
 * (Year / Coin Type / Denomination), and landed in the exceptions list. With
 * the country and the denomination both read correctly it now imports on two
 * of three, with Coin Type legitimately blank.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT REUSE image-matching/denomination-units.ts
 * ---------------------------------------------------------------------------
 * That file was read first, and it is doing a genuinely different job. It
 * reads US face values out of PHOTO FILENAMES, where its governing rule is
 * "a bare number means nothing, a number bound to a unit means a lot" -- the
 * unit being "$", the cent sign, or a hyphen welding a digit to the word
 * "cent". Its vocabulary is US-only by design and it is forbidden from ever
 * reading a bare digit.
 *
 * This file keeps the same *principle* -- a number is only a denomination
 * when it is bound to a currency unit -- but applies it to a world-coinage
 * vocabulary that file does not have and should not grow. Nothing is
 * duplicated: there is no overlap between "100 Soles" and "$20".
 *
 * ---------------------------------------------------------------------------
 * THE CONSERVATISM RULE, APPLIED TO CURRENCY UNITS
 * ---------------------------------------------------------------------------
 * Some currency units name their country unambiguously. "Soles" is Peru;
 * nowhere else has ever struck a Sol. Those units are allowed to IMPLY a
 * country even when the name never says it.
 *
 * Other units are shared by a dozen issuers. "20 Francs" could be France,
 * Belgium, Switzerland or Luxembourg. "50 Pesos" could be Mexico, Chile,
 * Colombia or Argentina. For those, the DENOMINATION is still read -- it is
 * unambiguous -- but the COUNTRY is left blank unless the name says it
 * outright. Guessing "Mexico" for an Argentine coin would quietly attach the
 * wrong melt reference to it, which is the failure mode this whole project
 * tries to avoid.
 * =========================================================================== */

/** A country the parser can recognise by name. */
interface CountryEntry {
  /**
   * The canonical spelling written into the record. These must match the
   * `country` values used in `pm-reference.ts`, or a recognised country would
   * silently lose its precious-metal lookup.
   */
  canonical: string;
  /**
   * The two-letter ISO code this country is ALSO known by in this app.
   *
   * THE CODE-VERSUS-NAME MISMATCH, IN ONE PLACE
   * -------------------------------------------
   * The app stores a country two different ways depending on which table you
   * are looking at, and nothing joins them without this field:
   *
   *   Denominations.Country  -> a two-letter CODE.  'US', 'GB'
   *                             (16 US rows and 22 GB rows in the seed)
   *   Coins.Country          -> a FULL NAME.        'United States'
   *                             (what every creation path writes)
   *
   * So a British coin says "Great Britain" while its denominations say "GB",
   * and a naive `coin.country === denomination.country` comparison matches
   * nothing at all. `resolveCountryName()` below is the bridge: run BOTH
   * sides through it and compare the canonical names that come back.
   *
   * This is deliberately the only place the mapping lives. Putting a second
   * copy in the editor would be how the two drift apart.
   *
   * Optional because not every entry has one — 'Scotland' has no ISO alpha-2
   * code of its own, and a historic issuer may have none either. An entry
   * without a code is still fully usable by name.
   */
  code?: string;
  /**
   * Whole-word patterns that name this country. Every one is anchored with
   * \b on both sides and compiled case-insensitively, the same whole-token
   * discipline the grading-company patterns in `quicken-import.service.ts`
   * use, so "India" cannot match inside "Indian Head".
   */
  patterns: readonly RegExp[];
}

/* ---------------------------------------------------------------------------
 * THE COUNTRY VOCABULARY
 * ---------------------------------------------------------------------------
 * Deliberately broad -- this is a gold collection and world gold turns up in
 * all of these -- but every entry was checked against one question: COULD
 * THIS WORD APPEAR IN A US COIN'S NAME? Several nearly could, and those are
 * the entries carrying a negative look-ahead:
 *
 *   "Panama"   -> the 1915-S PANAMA-PACIFIC commemoratives are US coins, so
 *                 Panama only counts when "Pacific" does not follow.
 *   "Spanish"  -> the 1935 OLD SPANISH TRAIL half dollar is a US coin, so
 *                 "Spanish" only counts when "Trail" does not follow.
 *   "India"    -> written \bindia\b so that "Indian Head" and "Indian
 *                 Princess" (both US types) cannot match.
 *   "Colombia" -> spelled with an 'o'. The US "Columbian" Exposition half
 *                 dollar is spelled with a 'u' and is therefore safe; no
 *                 "Columbia" spelling is listed here on purpose.
 *   "Guinea"   -> OMITTED ENTIRELY. The Guinea is an English GOLD COIN, and
 *                 a name reading "1760 Guinea" means the coin, not the
 *                 African republic.
 * ------------------------------------------------------------------------- */
const COUNTRIES: readonly CountryEntry[] = [
  // --- The Americas ---
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
  // See the header note: "Panama-Pacific" is a US commemorative series.
  { canonical: 'Panama', code: 'PA', patterns: [/\bpanama\b(?!\s*[-–]?\s*pacific)/i] },
  { canonical: 'Nicaragua', code: 'NI', patterns: [/\bnicaraguan?\b/i] },
  { canonical: 'Honduras', code: 'HN', patterns: [/\bhondura(?:s|n)\b/i] },
  { canonical: 'Dominican Republic', code: 'DO', patterns: [/\bdominican\b/i] },
  { canonical: 'Haiti', code: 'HT', patterns: [/\bhaiti(?:an)?\b/i] },

  // --- Europe ---
  // "Great Britain" is the canonical spelling because pm-reference.ts uses it.
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

  // --- Africa and the Middle East ---
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

  // --- Asia and Oceania ---
  { canonical: 'China', code: 'CN', patterns: [/\bchin(?:a|ese)\b/i] },
  { canonical: 'Japan', code: 'JP', patterns: [/\bjapan(?:ese)?\b/i] },
  { canonical: 'Korea', code: 'KR', patterns: [/\bkorean?\b/i] },
  // \bindia\b only -- "Indian Head" and "Indian Princess" are US coin types.
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

/* ---------------------------------------------------------------------------
 * THE CURRENCY-UNIT VOCABULARY
 * ---------------------------------------------------------------------------
 * `singular`/`plural` are the spellings accepted in the text. `canonical` is
 * what gets written into the Denomination field, so "100 soles" and
 * "100 SOLES" both normalise to "100 Soles".
 *
 * `impliesCountry` is the conservatism switch described in the header. It is
 * set ONLY where the unit has exactly one issuer in practice. Anything shared
 * -- Peso, Franc, Mark, Pound, Dinar, Krona, Rupee, Escudo, Lira, Ducat,
 * Real, Crown, Dollar -- deliberately leaves it undefined.
 * ------------------------------------------------------------------------- */
interface CurrencyUnit {
  canonical: string;
  singular: string;
  plural?: string;
  /** Extra spellings, e.g. "Soles" is itself the plural of "Sol". */
  aliases?: readonly string[];
  /** Set only when this unit has one unmistakable issuer. */
  impliesCountry?: string;
}

const CURRENCY_UNITS: readonly CurrencyUnit[] = [
  // --- Units that name their own country ---
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
  // The Pond is the gold coin of the old South African Republic (ZAR), the
  // "Kruger pond". Safe to bind to a country because, like Soles, nobody
  // else ever struck one -- and the number-binding rule means the ordinary
  // English word "pond" can never match on its own.
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

  // --- Units shared by several issuers: denomination only, no country ---
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
  /* The euro has no impliesCountry, deliberately. Twenty-odd states issue
   * one, so "50 Euro" proves the denomination and nothing about the mint --
   * exactly the situation the francs and pesos above are in. The owner's
   * "2025 Italy 50 Euro 1/2 oz. Gold Proof" names its country anyway, and
   * detectCountry reads that from the word "Italy" without help from here. */
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
 * `100 Soles`, `20 francs`, `8 Reales`.
 *
 * Built once from the vocabulary above. The number is capped at four digits
 * (hyperinflation denominations such as "5000 Lei" exist) and must be
 * followed by whitespace or a hyphen and then a known unit -- the "a number
 * is only a denomination when it is BOUND TO A UNIT" rule.
 *
 * The leading `(?:^|[^\w$¢£.])` guard is what stops this matching
 * the tail of something bigger:
 *   - `[^\w]`       so "1969" in a year cannot be read as a quantity
 *   - `[^$¢£]` so a US "$20" is never re-read here
 *   - `[^.]`        so the "50" in a price like "2.50 Pesos" is not taken
 */
const NUMBER_AND_UNIT = new RegExp(
  `(?:^|[^\\w$¢£.])(\\d{1,4})[\\s-]+(${UNIT_SPELLINGS.map((entry) => entry.spelling).join('|')})\\b`,
  'i'
);

/** What `detectForeignDenomination` found, if anything. */
export interface ForeignDenomination {
  /** Normalised denomination for the record, e.g. "100 Soles". */
  denomination: string;
  /**
   * The country this unit proves, or '' when the unit is shared by several
   * issuers. See the conservatism rule in the header.
   */
  impliedCountry: string;
}

/**
 * Reads a `<number> <foreign currency unit>` denomination out of a security
 * name. Returns null when there is none -- which is the normal case for this
 * collection, where 43 of 44 coins are US.
 */
export function detectForeignDenomination(securityName: string): ForeignDenomination | null {
  const text = String(securityName ?? '');
  const match = NUMBER_AND_UNIT.exec(text);
  if (!match) return null;

  const quantity = match[1];
  const spelling = match[2].toLowerCase();
  const hit = UNIT_SPELLINGS.find((entry) => entry.spelling === spelling);
  if (!hit) return null;

  // A quantity of exactly 1 reads better in the singular: "1 Ducat", not
  // "1 Ducats". Everything else uses the canonical (usually plural) form.
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
 * Reads a country out of a security name.
 *
 * Two sources, in priority order:
 *   1. The country NAMED in the text ("Peru", "Mexico", "Great Britain").
 *   2. Failing that, a currency unit that can only belong to one country
 *      ("100 Soles" with no other clue still proves Peru).
 *
 * Returns '' when neither fires. The caller decides what to do with that --
 * the QIF importer keeps its long-standing default of "United States",
 * because this is an American collector's export and that default has been
 * right for every record but one.
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

/* ===========================================================================
 * THE CODE <-> NAME BRIDGE
 * ---------------------------------------------------------------------------
 * Everything below exists because the app spells "the same country" two
 * different ways, as documented on `CountryEntry.code`:
 *
 *     a DENOMINATION says its country is   'GB'
 *     a COIN          says its country is  'Great Britain'
 *
 * Neither spelling is wrong and neither is going away — the denomination
 * lookup table is seeded with codes, and every coin-creation path in the app
 * writes full names. Rather than rewrite one side (a data migration, with the
 * risk that goes with it), both sides are run through `resolveCountryName()`
 * and the CANONICAL NAME that comes out is what gets compared.
 *
 * That single choice also buys tolerance for free text, which matters because
 * the coin's Country field is a text box the user can type anything into:
 * 'GB', 'uk', 'British', 'United Kingdom' and 'Great Britain' all resolve to
 * the one canonical 'Great Britain'.
 * =========================================================================== */

/** Code (upper-cased) -> canonical name. Built once from the table above. */
const CANONICAL_BY_CODE: ReadonlyMap<string, string> = new Map(
  COUNTRIES.filter((entry) => entry.code).map((entry) => [entry.code!.toUpperCase(), entry.canonical])
);

/** Lower-cased canonical name -> canonical name, for an exact-spelling hit. */
const CANONICAL_BY_NAME: ReadonlyMap<string, string> = new Map(
  COUNTRIES.map((entry) => [entry.canonical.toLowerCase(), entry.canonical])
);

/**
 * Resolve ANY country spelling this app might hold to one canonical name.
 *
 * Accepts, in this priority order:
 *   1. the canonical name itself     -> 'Great Britain', 'great britain'
 *   2. a two-letter code             -> 'GB', 'gb', 'US'
 *   3. anything the patterns know    -> 'UK', 'British', 'England'
 *
 * Returns '' when it cannot tell. THAT RETURN VALUE IS LOAD-BEARING: callers
 * are required to treat '' as "no opinion" and fall back to showing
 * everything, never to filtering down to nothing. A country this file has
 * never heard of must not strand the user with an empty dropdown.
 *
 * Why the code check comes BEFORE the patterns: the patterns are written for
 * prose ("1911 British Sovereign") and none of them matches a bare 'GB' or
 * 'US', so without the explicit code lookup the denomination table's own
 * spelling would resolve to nothing.
 *
 * Why the exact-name check comes before BOTH: it is the common case (a coin
 * already holding 'United States') and it skips 70-odd regex tests.
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
 * Do these two spellings mean the same country?
 *
 * The comparison the whole country/denomination link is built on. Both sides
 * are resolved first, so 'GB' and 'Great Britain' are equal.
 *
 * The fallback matters: when NEITHER side resolves (two denominations filed
 * under a made-up code such as 'XX', say) they are compared as plain text, so
 * an unknown country still groups with itself instead of every unknown
 * collapsing into one heap. If only one side resolves, they are not equal —
 * we know one of them and it is not the other.
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

/**
 * A country spelling turned into something worth showing a human.
 *
 * 'GB' becomes 'Great Britain'; anything unrecognised is handed back exactly
 * as stored, because an unknown value is still the user's data and hiding it
 * behind a placeholder would be worse than showing it raw.
 */
export function countryDisplayName(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  return resolveCountryName(text) || text;
}

/**
 * Every canonical country name, alphabetically.
 *
 * Feeds the Country box's <datalist> of suggestions. It is a SUGGESTION list,
 * not a constraint — see the comment on the input in coin-editor-form.html.
 */
export function allCountryNames(): string[] {
  return COUNTRIES.map((entry) => entry.canonical).sort((left, right) => left.localeCompare(right));
}
