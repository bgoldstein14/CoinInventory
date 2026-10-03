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
  { canonical: 'United States', patterns: [/\bunited\s+states\b/i, /\bu\.?s\.?a\.?\b/i, /\bamerican?\b/i] },
  { canonical: 'Canada', patterns: [/\bcanad(?:a|ian)\b/i] },
  { canonical: 'Mexico', patterns: [/\bmexic(?:o|an)\b/i] },
  { canonical: 'Peru', patterns: [/\bperu(?:vian)?\b/i] },
  { canonical: 'Brazil', patterns: [/\bbrazil(?:ian)?\b/i, /\bbrasil\b/i] },
  { canonical: 'Argentina', patterns: [/\bargentin(?:a|e|ian)\b/i] },
  { canonical: 'Chile', patterns: [/\bchile(?:an)?\b/i] },
  { canonical: 'Colombia', patterns: [/\bcolombian?\b/i] },
  { canonical: 'Venezuela', patterns: [/\bvenezuelan?\b/i] },
  { canonical: 'Bolivia', patterns: [/\bbolivian?\b/i] },
  { canonical: 'Ecuador', patterns: [/\becuador(?:ian)?\b/i] },
  { canonical: 'Uruguay', patterns: [/\buruguay(?:an)?\b/i] },
  { canonical: 'Paraguay', patterns: [/\bparaguay(?:an)?\b/i] },
  { canonical: 'Cuba', patterns: [/\bcuban?\b/i] },
  { canonical: 'Guatemala', patterns: [/\bguatemalan?\b/i] },
  { canonical: 'Costa Rica', patterns: [/\bcosta\s+rica(?:n)?\b/i] },
  // See the header note: "Panama-Pacific" is a US commemorative series.
  { canonical: 'Panama', patterns: [/\bpanama\b(?!\s*[-–]?\s*pacific)/i] },
  { canonical: 'Nicaragua', patterns: [/\bnicaraguan?\b/i] },
  { canonical: 'Honduras', patterns: [/\bhondura(?:s|n)\b/i] },
  { canonical: 'Dominican Republic', patterns: [/\bdominican\b/i] },
  { canonical: 'Haiti', patterns: [/\bhaiti(?:an)?\b/i] },

  // --- Europe ---
  // "Great Britain" is the canonical spelling because pm-reference.ts uses it.
  {
    canonical: 'Great Britain',
    patterns: [/\bgreat\s+britain\b/i, /\bbritain\b/i, /\bbritish\b/i, /\bengl(?:and|ish)\b/i, /\bunited\s+kingdom\b/i, /\bu\.?k\.?\b/i]
  },
  { canonical: 'Scotland', patterns: [/\bscot(?:land|tish)\b/i] },
  { canonical: 'Ireland', patterns: [/\birish\b/i, /\bireland\b/i] },
  { canonical: 'France', patterns: [/\bfrance\b/i, /\bfrench\b/i] },
  { canonical: 'Germany', patterns: [/\bgerman(?:y)?\b/i, /\bprussian?\b/i, /\bbavarian?\b/i, /\bsaxony\b/i] },
  { canonical: 'Austria', patterns: [/\baustria(?:n)?\b/i, /\baustro[-\s]?hungar(?:y|ian)\b/i] },
  { canonical: 'Switzerland', patterns: [/\bswitzerland\b/i, /\bswiss\b/i, /\bhelvetia\b/i] },
  { canonical: 'Netherlands', patterns: [/\bnetherlands\b/i, /\bholland\b/i, /\bdutch\b/i] },
  { canonical: 'Belgium', patterns: [/\bbelgi(?:um|an)\b/i] },
  { canonical: 'Italy', patterns: [/\bital(?:y|ian)\b/i] },
  { canonical: 'Vatican', patterns: [/\bvatican\b/i] },
  { canonical: 'Spain', patterns: [/\bspain\b/i, /\bespa(?:n|ñ)a\b/i, /\bspanish\b(?!\s+trail)/i] },
  { canonical: 'Portugal', patterns: [/\bportug(?:al|uese)\b/i] },
  { canonical: 'Russia', patterns: [/\brussia(?:n)?\b/i, /\bussr\b/i, /\bsoviet\b/i] },
  { canonical: 'Poland', patterns: [/\bpol(?:and|ish)\b/i] },
  { canonical: 'Hungary', patterns: [/\bhungar(?:y|ian)\b/i] },
  { canonical: 'Czechoslovakia', patterns: [/\bczech(?:oslovakia)?\b/i] },
  { canonical: 'Yugoslavia', patterns: [/\byugoslavian?\b/i] },
  { canonical: 'Serbia', patterns: [/\bserbian?\b/i] },
  { canonical: 'Romania', patterns: [/\broumania\b/i, /\bromanian?\b/i] },
  { canonical: 'Bulgaria', patterns: [/\bbulgarian?\b/i] },
  { canonical: 'Greece', patterns: [/\bgree(?:ce|k)\b/i] },
  { canonical: 'Sweden', patterns: [/\bswed(?:en|ish)\b/i] },
  { canonical: 'Norway', patterns: [/\bnorw(?:ay|egian)\b/i] },
  { canonical: 'Denmark', patterns: [/\bden(?:mark)\b/i, /\bdanish\b/i] },
  { canonical: 'Finland', patterns: [/\bfin(?:land|nish)\b/i] },
  { canonical: 'Iceland', patterns: [/\biceland(?:ic)?\b/i] },
  { canonical: 'Turkey', patterns: [/\bturk(?:ey|ish)\b/i, /\bottoman\b/i] },

  // --- Africa and the Middle East ---
  { canonical: 'South Africa', patterns: [/\bsouth\s+africa(?:n)?\b/i, /\bkrugerrand\b/i, /\btransvaal\b/i] },
  { canonical: 'Egypt', patterns: [/\begypt(?:ian)?\b/i] },
  { canonical: 'Morocco', patterns: [/\bmorocc(?:o|an)\b/i] },
  { canonical: 'Tunisia', patterns: [/\btunisian?\b/i] },
  { canonical: 'Israel', patterns: [/\bisrael(?:i)?\b/i] },
  { canonical: 'Saudi Arabia', patterns: [/\bsaudi(?:\s+arabia)?\b/i] },
  { canonical: 'Iran', patterns: [/\biran(?:ian)?\b/i, /\bpersian?\b/i] },
  { canonical: 'Ethiopia', patterns: [/\bethiopian?\b/i] },
  { canonical: 'Nigeria', patterns: [/\bnigerian?\b/i] },
  { canonical: 'Kenya', patterns: [/\bkenyan?\b/i] },

  // --- Asia and Oceania ---
  { canonical: 'China', patterns: [/\bchin(?:a|ese)\b/i] },
  { canonical: 'Japan', patterns: [/\bjapan(?:ese)?\b/i] },
  { canonical: 'Korea', patterns: [/\bkorean?\b/i] },
  // \bindia\b only -- "Indian Head" and "Indian Princess" are US coin types.
  { canonical: 'India', patterns: [/\bindia\b/i] },
  { canonical: 'Thailand', patterns: [/\bthailand\b/i, /\bsiam(?:ese)?\b/i] },
  { canonical: 'Vietnam', patterns: [/\bviet\s?nam(?:ese)?\b/i] },
  { canonical: 'Indonesia', patterns: [/\bindonesian?\b/i] },
  { canonical: 'Philippines', patterns: [/\bphilippines?\b/i, /\bfilipino\b/i] },
  { canonical: 'Hong Kong', patterns: [/\bhong\s?kong\b/i] },
  { canonical: 'Singapore', patterns: [/\bsingapore(?:an)?\b/i] },
  { canonical: 'Malaysia', patterns: [/\bmalaysian?\b/i] },
  { canonical: 'Australia', patterns: [/\baustralian?\b/i] },
  { canonical: 'New Zealand', patterns: [/\bnew\s+zealand\b/i] }
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
  { canonical: 'Ducats', singular: 'ducat', plural: 'ducats' }
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
