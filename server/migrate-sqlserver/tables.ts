/**
 * migrate-sqlserver/tables.ts — WHICH TABLES MOVE WHOLESALE AND WHICH DO NOT.
 *
 * This division is design §4.10b, and getting it wrong is the headline risk
 * in Stage 2:
 *
 *   - copy a reference table wholesale and the owner ends up with TWO rows
 *     called '8 Reales' under Mexico. That does not add a denomination, it
 *     DELETES one: migrations/seed-sql.ts's header explains that an
 *     ambiguous label resolves to NULL, so every coin that pointed at it
 *     loses its link.
 *   - copy nothing and the issuer he added by hand, and the catalogue he
 *     soft-deleted because he does not use it, are both silently gone.
 *
 * So reference tables are RECONCILED (see reference-data.ts) and owner tables
 * are COPIED. The lists are here, in one place, because three other files
 * iterate them and a table that appeared in two of the three lists would be
 * migrated twice.
 */

/**
 * The eleven tables, parent before child. The order is the order they are
 * written in, so a foreign key always has its target already present.
 */
export const ALL_TABLES = [
  'Issuers',
  'Denominations',
  'Catalogs',
  'Categories',
  'MetalContents',
  'MintMarks',
  'CoinSets',
  'Coins',
  'CoinImages',
  'SpotPrices',
  'AppSettings',
] as const;

export type TableName = (typeof ALL_TABLES)[number];

/**
 * Tables db/seed.ts rebuilds from
 * `migrations/seed-data/issuers-denominations.json` and the literal lists
 * beside it. Their seeded rows are NOT migrated; only the owner's additions
 * and his edits to seeded rows are.
 */
export const REFERENCE_TABLES = [
  'Issuers',
  'Denominations',
  'Catalogs',
  'Categories',
  'MetalContents',
  'MintMarks',
] as const satisfies readonly TableName[];

/**
 * Tables with no seed at all. Every row in them is the owner's, so they are
 * copied row for row.
 *
 * *** CoinSets IS HERE AND Categories IS NOT, AND THAT IS NOT AN
 * INCONSISTENCY. *** They look like the same kind of lookup, but db/seed.ts
 * ships two categories ('20th Cent. Type', 'Odd Type Set') and ships no coin
 * sets. A table is a reference table here if, and only if, the seeder writes
 * to it.
 */
export const OWNER_TABLES = [
  'CoinSets',
  'Coins',
  'CoinImages',
  'SpotPrices',
  'AppSettings',
] as const satisfies readonly TableName[];

/**
 * Tables whose contents prove a target database is already in use.
 *
 * Reference tables cannot be part of this test — db/seed.ts fills them on
 * the first open, so a brand-new, untouched database already has 1,274 rows
 * in them. These five are empty on a database nobody has put anything into.
 */
export const OCCUPANCY_TABLES = OWNER_TABLES;

/**
 * The order rows are DELETED in by `--force`. The reverse of the write
 * order, so a child is gone before its parent.
 */
export const DELETE_ORDER = [
  'CoinImages',
  'Coins',
  'CoinSets',
  'SpotPrices',
  'AppSettings',
] as const satisfies readonly TableName[];

/**
 * The columns design §4.1 requires to be compared VALUE BY VALUE, not
 * counted and glanced at.
 *
 * SQLite has no decimal type; db/schema.sql chose REAL precisely so this
 * comparison is an exact `===` rather than a tolerance. If a future reader
 * finds themselves adding an epsilon, the answer is to find out why, not to
 * loosen this.
 */
export const COINS_NUMERIC_COLUMNS = [
  'Weight',
  'PmWeightGrams',
  'PmPercent',
  'PurchasePrice',
  'CurrentValue',
  'SoldPrice',
] as const;

/**
 * The other REAL columns in the schema. Not named by §4.1, which predates
 * them, but they are decimals that crossed the same boundary and checking
 * them costs one more pass over a few dozen rows.
 */
export const OTHER_NUMERIC_COLUMNS: ReadonlyArray<{
  table: TableName;
  key: readonly string[];
  columns: readonly string[];
}> = [
  {
    table: 'SpotPrices',
    key: ['SpotPriceId'],
    columns: ['Gold', 'Silver', 'Platinum', 'Copper'],
  },
];
