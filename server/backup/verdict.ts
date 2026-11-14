/**
 * backup/verdict.ts — WHAT RESTORE REFUSES, AND WHY, AS A PURE FUNCTION.
 *
 * *** THIS IS THE DANGEROUS HALF OF §16 AND IT IS DELIBERATELY THE DULLEST
 * FILE IN IT. *** Everything that decides whether a file is allowed to
 * replace somebody's collection is here, it takes plain facts and returns a
 * plain answer, and it touches no disk, no database and no HTTP. That is
 * what makes "refuse a newer schema" something a test can hold still rather
 * than something buried in a route handler behind two awaits.
 *
 * THE RULE THE WHOLE FEATURE TURNS ON: *a restore that half-works is worse
 * than one that refuses.* A refusal costs the user one confused minute. A
 * half-restore costs them a collection, and it does it quietly — the app
 * opens, the grid draws, and the coins added since March are simply not
 * there. So every check below is run BEFORE anything is moved, and anything
 * this file is not certain about is refused.
 *
 * FIVE REFUSALS AND TWO ACCEPTANCES, in the order they are decided:
 *
 *   missing       there is no file at that path
 *   not-sqlite    the first sixteen bytes are not SQLite's
 *   unreadable    SQLite would not open it (truncated, encrypted, corrupt)
 *   not-this-app  it is a SQLite database, but not Coin Inventory's
 *   newer-schema  it is ours, from a LATER build than this one
 *   ---
 *   ok            ours, and this build understands it
 *   unversioned   ours, with no version stamp — see below
 *
 * The order matters. Each check assumes the ones above it passed, which is
 * why the table check can trust that there is a readable database to have
 * tables at all.
 */

import { SCHEMA_VERSION, UNSTAMPED_SCHEMA_VERSION } from '../db';

/**
 * The tables a Coin Inventory database has. All of them must be present;
 * this is the test for "is this OUR database".
 *
 * WHY ALL ELEVEN AND NOT JUST `Coins`. A file with a Coins table and no
 * Denominations table is not a Coin Inventory backup — it is something else
 * that happens to share a noun, or one of ours that was truncated in
 * transit. Restoring it would produce an application that starts, shows an
 * empty grid and throws on the first lookup. Checking the full set costs one
 * query and turns that into a refusal.
 *
 * It is NOT read from db/schema.sql on purpose. This list is the contract
 * for what an ACCEPTABLE FILE looks like; schema.sql is what this build
 * creates. Deriving one from the other would mean that adding a table to
 * schema.sql silently started rejecting every backup in existence, which is
 * precisely the decision SCHEMA_VERSION exists to make explicit.
 * db/schema.spec.ts asserts the two agree today.
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
  /** True ONLY for 'ok' and 'unversioned'. The single gate on the restore. */
  readonly acceptable: boolean;
  /** One sentence for the user. No jargon, no stack traces, no file paths. */
  readonly message: string;
  /** Which REQUIRED_TABLES were absent. Empty unless 'not-this-app'. */
  readonly missingTables: readonly string[];
}

/**
 * Decides whether this file may replace the user's collection.
 *
 * Pure: same facts in, same answer out, every time. The caller does not get
 * to override it — backup/restore.ts calls this and stops on `acceptable`
 * being false, and it calls it AGAIN at the moment of the swap rather than
 * trusting the answer the dialog was shown. A user can edit a path between
 * pressing Inspect and pressing Restore.
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

  /* *** THE REFUSAL WITH NO WAY ROUND IT. ***
   *
   * There is no migration runner in this application and there is
   * deliberately not going to be one yet (db/schema.ts). A file from a
   * later build cannot be read DOWN: this build does not know what the
   * later one added, so it cannot drop it, and it cannot know which of the
   * columns it does recognise now mean something different.
   *
   * The temptation is to "try anyway, it is probably fine". It usually
   * would be. The time it is not, the user has already let us move their
   * good collection aside to make room for a file we then mangle — and the
   * mangling is silent, because a column this build never reads is a column
   * it never notices is missing. So: refused, by number, before anything
   * moves. The message names both versions because "upgrade Coin Inventory"
   * is the actual fix and the user needs to recognise that it applies. */
  if (version > SCHEMA_VERSION) {
    return refuse(
      'newer-schema',
      `That backup was made by a newer version of Coin Inventory (collection format ` +
        `${version}; this version understands up to ${SCHEMA_VERSION}). Update Coin ` +
        `Inventory to the latest version and try again. Your current collection has ` +
        `not been touched.`
    );
  }

  /* UNVERSIONED IS NOT A PROBLEM, IT IS A DATE.
   *
   * `PRAGMA user_version` defaults to 0 and this application never set it
   * before 2026-11-14, so every database older than that reads 0. Those
   * files have the eleven tables above — nothing in the schema changed when
   * the stamp was introduced — and the table check has already passed, so
   * they are accepted on the strength of their SHAPE rather than their
   * number. The dialog still says so, because "we cannot tell exactly which
   * version wrote this" is true and the user is about to replace a
   * collection with it. */
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
