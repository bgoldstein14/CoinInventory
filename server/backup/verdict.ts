/**
 * Decides whether a file may replace the collection, as a pure function of
 * facts gathered by backup/inspect.ts. Anything uncertain is refused, since a
 * half-working restore silently loses data. Checked in order (each assumes the
 * previous passed):
 *
 *   missing       no file at that path
 *   not-sqlite    the header isn't SQLite's
 *   unreadable    SQLite won't open it (truncated, encrypted, corrupt)
 *   not-this-app  a SQLite database, but not Coin Inventory's
 *   newer-schema  ours, from a later build
 *   ---
 *   ok            ours, and this build understands it
 *   unversioned   ours, with no version stamp (accepted)
 */

import { SCHEMA_VERSION, UNSTAMPED_SCHEMA_VERSION } from '../db';

/**
 * The tables a Coin Inventory database must have; all must be present for a
 * file to count as ours (a partial set is something else, or truncated).
 * Hand-written rather than read from db/schema.sql: this is the contract for
 * an acceptable file, and adding a table must not silently reject old backups
 * (that's what SCHEMA_VERSION is for). backup/verdict.spec.ts checks they match.
 */
export const REQUIRED_TABLES: readonly string[] = [
  'AppSettings',
  'Catalogs',
  'Categories',
  'CoinImages',
  'CoinSets',
  'Coins',
  'Denominations',
  'Issuers',
  'MetalContents',
  'MintMarks',
  'SpotPrices',
];

/**
 * Tables a current database has that older backups may lack. Opening a file
 * creates them and db/schema.ts upgradeSchema() fills them, so they are not required.
 */
export const TABLES_CREATED_ON_OPEN: readonly string[] = ['CoinCatalogRefs'];

export type RestoreVerdict =
  | 'ok'
  | 'unversioned'
  | 'missing'
  | 'not-sqlite'
  | 'unreadable'
  | 'not-this-app'
  | 'newer-schema';

/** Everything the decision needs. Gathered by backup/inspect.ts. */
export interface CandidateFacts {
  /** Is there a file at the path at all? */
  readonly fileExists: boolean;
  /** Do the first sixteen bytes say `SQLite format 3\0`? */
  readonly looksLikeSqlite: boolean;
  /** The message SQLite gave when opening failed, or null if it opened. */
  readonly openError: string | null;
  /** Every user table found, or an empty list when it never opened. */
  readonly tables: readonly string[];
  /** `PRAGMA user_version`, or null when it never opened. */
  readonly schemaVersion: number | null;
}

export interface RestoreDecision {
  readonly verdict: RestoreVerdict;
  /** True only for 'ok' and 'unversioned'. */
  readonly acceptable: boolean;
  /** One sentence for the user. No jargon, no stack traces, no file paths. */
  readonly message: string;
  /** Which REQUIRED_TABLES were absent. Empty unless 'not-this-app'. */
  readonly missingTables: readonly string[];
}

/**
 * Decides whether this file may replace the user's collection.
 * backup/restore.ts calls it again at swap time, since the path may have
 * changed after the dialog showed its verdict.
 */
export function classifyRestoreCandidate(facts: CandidateFacts): RestoreDecision {
  if (!facts.fileExists) {
    return refuse(
      'missing',
      'There is no file at that location. Check the path and try again.'
    );
  }

  if (!facts.looksLikeSqlite) {
    return refuse(
      'not-sqlite',
      'That file is not a Coin Inventory backup. A backup is a single .db file ' +
        'created by this app — not a spreadsheet, a photo or a zip.'
    );
  }

  if (facts.openError !== null) {
    return refuse(
      'unreadable',
      'That file looks like a database but could not be opened. It may have been ' +
        'damaged, or only partly copied. Try the original backup, or another one.'
    );
  }

  const missingTables = REQUIRED_TABLES.filter((table) => !facts.tables.includes(table));
  if (missingTables.length > 0) {
    return {
      verdict: 'not-this-app',
      acceptable: false,
      message:
        'That is a database, but it is not a Coin Inventory collection — it is ' +
        'missing information the app needs. Nothing has been changed.',
      missingTables,
    };
  }

  const version = facts.schemaVersion ?? UNSTAMPED_SCHEMA_VERSION;

  // A newer build's file can't be read safely (no downgrade path; changes
  // would be silently lost), so refuse it and name both versions.
  if (version > SCHEMA_VERSION) {
    return refuse(
      'newer-schema',
      `That backup was made by a newer version of Coin Inventory (collection format ` +
        `${version}; this version understands up to ${SCHEMA_VERSION}). Update Coin ` +
        `Inventory to the latest version and try again. Your current collection has ` +
        `not been touched.`
    );
  }

  // Version 0 means made before stamping existed. Those files have the same
  // tables and the table check passed, so accept them; the dialog says so.
  if (version === UNSTAMPED_SCHEMA_VERSION) {
    return {
      verdict: 'unversioned',
      acceptable: true,
      message:
        'This backup was made before Coin Inventory started recording which version ' +
        'wrote a file, so its version cannot be confirmed. It has the right shape and ' +
        'can be restored.',
      missingTables: [],
    };
  }

  return {
    verdict: 'ok',
    acceptable: true,
    message: 'This is a Coin Inventory backup and can be restored.',
    missingTables: [],
  };
}

function refuse(verdict: RestoreVerdict, message: string): RestoreDecision {
  return { verdict, acceptable: false, message, missingTables: [] };
}
