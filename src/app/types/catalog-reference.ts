/* catalog-reference.ts — a coin's catalogue reference ("Sear 6819").
 *
 * WHAT THIS FILE OWNS
 *   The Catalogs lookup row as the app sees it, the seed list, and the three
 *   small functions that turn (catalogId, catalogNumber) into the one string
 *   a human recognises. Nothing else in the app is allowed to concatenate a
 *   catalogue name and a number by hand.
 *
 * WHY THE FIELD EXISTS AT ALL
 *   Ancients and world coins are identified by catalogue reference far more
 *   than by denomination -- an unattributed Judaean bronze has no year, no
 *   denomination and no grade, but it does have `Hendin 1234`. Without this
 *   field such references get typed into `variety`, which is the wrong box.
 *   There is ONE reference per coin rather than the child table that would
 *   eventually be correct.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: LOOK ANYTHING UP
 *   Entering `Sear 6819` does not fill in the year, the type or the metal.
 *   This was deferred on availability grounds, not licensing ones: of the
 *   catalogues in the seed below, only RIC and Crawford have an open
 *   machine-readable source (OCRE and CRRO, via Nomisma), and numismatics.org
 *   answers HTTP 403 to automated requests. Sear, Hendin and Krause have no
 *   queryable source at all. A half-working lookup that silently fills
 *   nothing for three catalogues out of five is worse than no lookup, so
 *   there is no resolver, no stub and no "coming soon" button here.
 *
 * WHY IT IS ITS OWN FILE WITH ZERO IMPORTS
 *   Four unrelated places need these rules -- the grid cell, the editor, the
 *   search haystack and the maintenance screen -- and one of them
 *   (inventory-columns.ts) is already imported by half the app. A leaf module
 *   with no imports of its own cannot take part in an import cycle, which
 *   otherwise throws "Cannot access ... before initialization" at start-up.
 *
 *   In particular this file does NOT import CoinRecord. The functions take
 *   the two values rather than the coin, which is also what makes them
 *   testable with two string literals under Node with no jsdom.
 */

/**
 * One row of the Catalogs lookup table, as `GET /api/catalogs` returns it.
 *
 * Shaped like `Denomination` and `MintMarkOption` in coin.model.ts on
 * purpose: it is maintained by the same kind of screen, through the same kind
 * of soft-delete routes, and a reader who knows one knows all three.
 */
export interface CatalogOption {
  /** Catalogs.CatalogId -- the value stored in Coins.CatalogId. */
  catalogId: number;
  /** Catalogs.Name NVARCHAR(60) -- 'Sear', 'RIC', 'Krause (KM)'. */
  name: string;
  /** Display order in the picker. Seeded 1..15; user additions go on the end. */
  sortOrder: number;
  /**
   * False once the user has removed it. Removed catalogues vanish from the
   * PICKER but are still named in the grid -- see catalogNameById below.
   */
  isActive: boolean;
}

/**
 * Catalogs.Name is NVARCHAR(60); Coins.CatalogNumber is NVARCHAR(50).
 *
 * Both constants exist so the inputs that write them can be capped at exactly
 * the column width. A `maxlength` larger than the column means SQL Server
 * raises error 8152 and the whole save is lost; the mssql driver, bound the
 * other way round, truncates silently instead. Neither failure is one the
 * user can diagnose, so the two numbers are stated once and asserted against
 * setup-database.sql by server/migrations/migration-012.spec.ts.
 */
export const CATALOG_NAME_MAX_LENGTH = 60;
export const CATALOG_NUMBER_MAX_LENGTH = 50;

/**
 * The catalogues a fresh database is seeded with.
 *
 * *** THIS IS NOT AN ARBITRARY LIST. ***
 * The first fourteen are `CATALOG_PREFIXES` from
 * services/image-matching/filename-vocabulary.ts, expanded from the matcher's
 * lower-case tokens into the names a person reads. That list was built by
 * reading the owner's actual photo filenames, so it IS the set of catalogues
 * this collection uses -- which is why seeding from it gives a dropdown whose
 * first entry is usually the right one.
 *
 * The fifteenth, Krause (KM), is the one addition: world-coin numbering, which
 * no filename in the collection mentions but which anyone cataloguing modern
 * foreign coins needs. It is LAST so that the first fourteen stay a clean
 * one-to-one expansion of the matcher's list, which is exactly how
 * catalog-reference.spec.ts checks the two have not drifted apart.
 *
 * The order is the seeded SortOrder, so the dropdown opens with the
 * catalogues the collection actually uses at the top rather than in
 * alphabetical order, where `BMC` would lead and `Sear` would be eleventh.
 *
 * It is a seed, not a closed set: the maintenance screen adds, renames and
 * removes catalogues, exactly as it does for denominations and mint marks.
 */
export const CATALOG_SEED: readonly string[] = [
  'Sear',       // David Sear -- Greek / Roman / Byzantine. The owner's first choice.
  'RIC',        // Roman Imperial Coinage
  'Hendin',     // Guide to Biblical Coins (Judaea)
  'RPC',        // Roman Provincial Coinage
  'Svoronos',   // Ptolemaic
  'BMC',        // British Museum Catalogue
  'SNG',        // Sylloge Nummorum Graecorum
  'Crawford',   // Roman Republican Coinage (RRC)
  'Sydenham',   // The Coinage of the Roman Republic
  'Cohen',      // Description historique des monnaies ... romaines
  'RSC',        // Roman Silver Coinage
  'Meshorer',   // Ancient Jewish Coinage
  'TJC',        // A Treasury of Jewish Coins
  'Kraay',      // Archaic and Classical Greek Coins
  'Krause (KM)' // Standard Catalog of World Coins -- the one NOT from the matcher
];

/**
 * The catalogue's display name for an id, or '' when we cannot say.
 *
 * '' RATHER THAN A PLACEHOLDER, in all four "cannot say" cases -- no id, a
 * null id, an id that is not in the list, and no list loaded yet. The callers
 * then render the number on its own, which is the honest reading: we know the
 * user wrote 6819, we do not know which catalogue. Inventing "Unknown 6819"
 * or hiding the number entirely would both be worse.
 *
 * TWO THINGS HERE ARE DELIBERATE AND EASY TO "TIDY" AWAY:
 *
 *   1. THE COMPARISON IS LOOSE, VIA Number(). The CSV importer copies cells
 *      into the record verbatim, so a coin that came back in through
 *      Export -> CSV -> Import carries `catalogId` as the STRING "3". A `===`
 *      lookup answers nothing for every such coin and the catalogue silently
 *      disappears from the grid. Coercing once, here, fixes it for every
 *      caller instead of asking each of them to remember.
 *
 *   2. INACTIVE ROWS STILL ANSWER. Removing a catalogue is a soft delete
 *      (IsActive = 0) and the coins pointing at it are untouched, exactly as
 *      mint marks and denominations already behave. Those coins must keep
 *      reading "Sear 6819"; it is only the PICKER that hides retired entries.
 */
export function catalogNameById(
  catalogs: readonly CatalogOption[] | undefined,
  catalogId: number | null | undefined
): string {
  if (catalogId === null || catalogId === undefined) return '';
  // Via String() rather than `=== ''`: the declared type is a number, but a
  // CSV round-trip really can put an empty STRING here, and Number('') is 0
  // -- a finite value that would then be looked up as though it were an id.
  if (String(catalogId).trim() === '') return '';
  if (!catalogs || catalogs.length === 0) return '';

  const wanted = Number(catalogId);
  if (!Number.isFinite(wanted)) return '';

  return catalogs.find(catalog => Number(catalog.catalogId) === wanted)?.name ?? '';
}

/**
 * The reference as a human writes it: `Sear 6819`.
 *
 * All four combinations are legal and all four have a meaning:
 *
 *   both      'Sear 6819'  a complete reference
 *   name only 'Sear'       picked the catalogue, has not typed the number yet
 *   num only  '6819'       imported, or the catalogue was not recognised
 *   neither   ''           the overwhelming majority of coins
 *
 * ONLY THE OUTER EDGES ARE TRIMMED. `II.1 234` and `RRC 44/5` are real
 * reference formats, so nothing here collapses internal spaces, strips
 * punctuation or changes case. The number is stored and shown exactly as the
 * user typed it; a reference the app "tidied" is a reference that no longer
 * matches the book.
 */
export function formatCatalogReference(
  catalogName: string | null | undefined,
  catalogNumber: string | null | undefined
): string {
  const name = (catalogName ?? '').trim();
  const number = (catalogNumber ?? '').trim();

  if (name && number) return `${name} ${number}`;
  return name || number;
}

/**
 * The two convenience steps in one, for the callers that hold a coin's two
 * stored fields and the lookup list: resolve the id, then format.
 *
 * Every display of a catalogue reference in the app goes through this -- the
 * grid cell, the search haystack, the editor's summary. One function means
 * the grid can never show something the search cannot find.
 */
export function coinCatalogReference(
  catalogs: readonly CatalogOption[] | undefined,
  catalogId: number | null | undefined,
  catalogNumber: string | null | undefined
): string {
  return formatCatalogReference(catalogNameById(catalogs, catalogId), catalogNumber);
}
