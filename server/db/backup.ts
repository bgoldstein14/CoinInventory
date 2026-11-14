/**
 * db/backup.ts — THE FILE-LEVEL OPERATIONS §16 NEEDS, kept inside the data
 * layer so that nothing outside db/ ever holds a raw SQLite handle.
 *
 * Three things, and they are the only three:
 *
 *   copyDatabaseFile()       a consistent copy of a LIVE database, taken
 *                            through SQLite's online backup API
 *   readDatabaseFileFacts()  open a candidate file READ-ONLY and report
 *                            what it is, without changing it
 *   writeBackupMetadata()    stamp a finished copy with what it contains
 *
 * *** WHY THE SPLIT IS HERE AND NOT SOMEWHERE MORE OBVIOUS. ***
 * db/driver.ts is the only file in the repository allowed to name a SQLite
 * package, and db/driver-isolation.spec.ts fails the build if that stops
 * being true. backup/ needs to open two files that are not the application's
 * database — the copy it is writing and the file the user is offering — and
 * it needs to do it without importing the driver's handle type and without
 * learning what a `prepare()` is. So the handles live and die inside this
 * module and the callers get plain data back.
 *
 * Everything here works on FILE PATHS, deliberately. The one operation that
 * takes an open database (the backup source) opens its own read-only handle
 * rather than borrowing the application's, which is explained at the call.
 */

import fs from 'fs';

import { BUSY_TIMEOUT_MS } from './config';
import {
  backupSqliteDatabase,
  openSqliteDatabase,
  type SqliteBackupProgress,
  type SqliteDatabase,
} from './driver';
import { readSchemaVersion } from './schema';

/**
 * The first sixteen bytes of every SQLite database ever written, including
 * the trailing NUL. Checked before anything is opened, because
 * "SQLiteError: file is not a database" is a worse answer to "I picked my
 * holiday photo by mistake" than "that is not a Coin Inventory backup".
 */
export const SQLITE_FILE_HEADER = 'SQLite format 3\u0000';

/** How many bytes to read to decide whether a file is SQLite at all. */
const HEADER_BYTES = 16;

/**
 * An EMPTY file is a SQLite database, as far as SQLite is concerned: opening
 * one creates the schema in it. That is a perfectly sensible rule for
 * `new DatabaseSync()` and a trap for us, so a zero-length file is rejected
 * on sight rather than being opened and found to contain no tables.
 */
export function looksLikeSqliteFile(filePath: string): boolean {
  let handle: number | null = null;
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size === 0) return false;

    handle = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEADER_BYTES, 0);
    if (read < HEADER_BYTES) return false;
    return buffer.toString('latin1') === SQLITE_FILE_HEADER;
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* nothing useful to do about a failed close of a read handle */
      }
    }
  }
}

/** What a candidate file turned out to contain. Plain data, no handles. */
export interface DatabaseFileFacts {
  /** `PRAGMA user_version`. 0 for a file written before stamping existed. */
  readonly schemaVersion: number;
  /** Every user table in the file, sorted. Empty for a stranger's database. */
  readonly tables: readonly string[];
  /** Rows in Coins, or null when there is no Coins table. */
  readonly coinCount: number | null;
  /** Rows in CoinImages, or null when there is no CoinImages table. */
  readonly imageCount: number | null;
  /**
   * Photographs whose picture is INSIDE the file (ImageData present). These
   * travel; they are the whole point of 'stored' mode.
   */
  readonly storedImageCount: number | null;
  /**
   * *** THE NUMBER THAT BREAKS ON ANOTHER MACHINE. *** Photographs with no
   * ImageData and only a SourcePath: the file holds a pointer to a folder
   * that may not exist on the PC doing the restore. See backup/inspect.ts,
   * which turns this into a sentence the user reads BEFORE committing.
   */
  readonly referencedOnlyImageCount: number | null;
  /**
   * The distinct FOLDERS those SourcePaths point into, capped. Folders, not
   * files: a collection with 3,000 referenced photos usually has a handful
   * of folders, and naming the folder is what lets somebody recognise
   * "that drive is not plugged into this machine".
   */
  readonly referencedFolders: readonly string[];
  /** The `backup.*` rows from AppSettings, if the file carries them. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** Tables we count rows in, guarded by their presence in `tables`. */
const COINS_TABLE = 'Coins';
const IMAGES_TABLE = 'CoinImages';
const SETTINGS_TABLE = 'AppSettings';

/** Cap on distinct SourcePath rows pulled back for the folder summary. */
const SOURCE_PATH_SAMPLE_LIMIT = 5000;

/** Cap on folders reported. Nobody reads a list of two hundred. */
const REFERENCED_FOLDER_LIMIT = 12;

/** The AppSettings key prefix a backup stamps itself with. */
export const BACKUP_METADATA_PREFIX = 'backup.';

/**
 * Opens `filePath` READ-ONLY and reports what is in it.
 *
 * *** READ-ONLY IS A CORRECTNESS REQUIREMENT, NOT CAUTION. *** This is run
 * against a file the user has not agreed to restore yet, and possibly
 * against their only copy of a collection. Opening a SQLite database
 * read-write can rewrite the header, roll back a hot journal and upgrade
 * the file format. Looking must not change the thing being looked at.
 *
 * Throws if the file cannot be opened as a database. The caller
 * (backup/inspect.ts) turns that into a verdict; it is not handled here,
 * because "what to tell the user" is a different question from "what is in
 * the file".
 */
export function readDatabaseFileFacts(filePath: string): DatabaseFileFacts {
  return withoutLeavingSidecars(filePath, () => {
    const database = openSqliteDatabase({
      filename: filePath,
      // Off. Foreign keys are a constraint on WRITES and there are none here;
      // leaving them on would make opening a file with pre-existing orphan
      // rows a failure of the INSPECTION rather than something the user gets
      // told about.
      enableForeignKeyConstraints: false,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      readOnly: true,
    });

    try {
      return gatherFacts(database);
    } finally {
      database.close();
    }
  });
}

/** The two files a WAL-mode database keeps beside itself. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * Runs `work`, then removes any `-wal` / `-shm` THIS CALL caused to appear.
 *
 * *** WHY THIS IS NEEDED AT ALL. *** `backup()` reproduces the source's
 * journal mode, so every backup file this feature writes is a WAL database.
 * Opening a WAL database — even READ-ONLY — makes SQLite create the shared
 * memory file beside it, and a read-only connection cannot clean them up
 * when it closes (verified: a read-only open-and-close of a single-file
 * backup leaves `x.db-shm` and `x.db-wal` next to it). The user would then
 * find two mystery files appearing beside their backup every time they
 * merely LOOKED at it in the restore dialog, which is both alarming and the
 * sort of thing that gets a feature distrusted.
 *
 * *** WHY IT ONLY DELETES WHAT IT CREATED. *** A `-wal` that was already
 * there holds committed transactions, and deleting it would throw away
 * exactly the recent data this whole feature exists to preserve. So the
 * presence of each sidecar is recorded BEFORE `work` and only the ones that
 * were absent then are removed — and only after `work` has closed its
 * handle, so the content has been folded in or was never there.
 */
function withoutLeavingSidecars<T>(filePath: string, work: () => T): T {
  const preexisting = new Set(
    SIDECAR_SUFFIXES.filter((suffix) => fs.existsSync(`${filePath}${suffix}`))
  );

  try {
    return work();
  } finally {
    for (const suffix of SIDECAR_SUFFIXES) {
      if (preexisting.has(suffix)) continue;
      try {
        fs.rmSync(`${filePath}${suffix}`, { force: true });
      } catch {
        // Best effort. A sidecar we could not remove is untidy; failing the
        // inspection over it would be worse.
      }
    }
  }
}

function gatherFacts(database: SqliteDatabase): DatabaseFileFacts {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((row) => String(row['name']));

  const has = (table: string): boolean => tables.includes(table);
  const countOf = (sql: string): number => Number(database.prepare(sql).all()[0]?.['n'] ?? 0);

  const coinCount = has(COINS_TABLE) ? countOf(`SELECT COUNT(*) AS n FROM ${COINS_TABLE}`) : null;

  let imageCount: number | null = null;
  let storedImageCount: number | null = null;
  let referencedOnlyImageCount: number | null = null;
  let referencedFolders: string[] = [];

  if (has(IMAGES_TABLE)) {
    imageCount = countOf(`SELECT COUNT(*) AS n FROM ${IMAGES_TABLE}`);
    // `ImageData IS NOT NULL` rather than `LENGTH(ImageData) > 0`: an empty
    // string would be a bug upstream, and counting it as "not stored" here
    // would hide that bug behind a reassuring number.
    storedImageCount = countOf(
      `SELECT COUNT(*) AS n FROM ${IMAGES_TABLE} WHERE ImageData IS NOT NULL`
    );
    referencedOnlyImageCount = countOf(
      `SELECT COUNT(*) AS n FROM ${IMAGES_TABLE} ` +
        `WHERE ImageData IS NULL AND SourcePath IS NOT NULL AND TRIM(SourcePath) <> ''`
    );
    referencedFolders = distinctFolders(
      database
        .prepare(
          `SELECT DISTINCT SourcePath FROM ${IMAGES_TABLE} ` +
            `WHERE SourcePath IS NOT NULL AND TRIM(SourcePath) <> '' ` +
            `LIMIT ${SOURCE_PATH_SAMPLE_LIMIT}`
        )
        .all()
        .map((row) => String(row['SourcePath']))
    );
  }

  const metadata: Record<string, string> = {};
  if (has(SETTINGS_TABLE)) {
    for (const row of database
      .prepare(
        `SELECT SettingKey, SettingValue FROM ${SETTINGS_TABLE} ` +
          `WHERE SettingKey LIKE '${BACKUP_METADATA_PREFIX}%'`
      )
      .all()) {
      metadata[String(row['SettingKey'])] = String(row['SettingValue'] ?? '');
    }
  }

  return {
    schemaVersion: readSchemaVersion(database),
    tables,
    coinCount,
    imageCount,
    storedImageCount,
    referencedOnlyImageCount,
    referencedFolders,
    metadata,
  };
}

/**
 * The folders a list of file paths live in, de-duplicated and capped.
 *
 * `path.dirname` is deliberately NOT used. The paths in the database were
 * written on a Windows machine and are read back on whatever machine is
 * running — including a POSIX CI box, where `path.dirname` would hand back
 * the whole `D:\Photos\coin.jpg` string unchanged because it sees no
 * separator. Splitting on both separators is correct in both directions and
 * this is a display string, not a path we are going to open.
 */
export function distinctFolders(sourcePaths: readonly string[]): string[] {
  const seen = new Set<string>();

  for (const raw of sourcePaths) {
    const value = raw.trim();
    if (value.length === 0) continue;

    const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
    // No separator at all means a bare file name, which tells a user
    // nothing about which machine it came from. Skipped rather than
    // reported as a folder called "".
    if (cut <= 0) continue;

    seen.add(value.slice(0, cut));
    if (seen.size >= REFERENCED_FOLDER_LIMIT) break;
  }

  return [...seen].sort();
}

/** Everything copyDatabaseFile() needs. */
export interface CopyDatabaseOptions {
  /** The LIVE database file to copy. Never ':memory:' — see below. */
  readonly sourceFile: string;
  /** Where the copy goes. Its directory must already exist. */
  readonly destination: string;
  /** Pages per batch. See db/driver.ts's SqliteBackupOptions. */
  readonly rate: number;
  /** Called after each batch. Throwing from it cancels the backup. */
  readonly onProgress: (progress: SqliteBackupProgress) => void;
}

/**
 * Copies a live database to `destination`, consistently, while the
 * application keeps running.
 *
 * *** IT OPENS ITS OWN READ-ONLY SOURCE HANDLE RATHER THAN BORROWING THE
 * APPLICATION'S. *** Two reasons, and the second is the one that decided it:
 *
 *   1. A handle that cannot write cannot damage the collection it is
 *      copying. The backup job is then structurally incapable of being the
 *      thing that goes wrong.
 *   2. The shared handle is guarded by DbConnection's lock (db/sql-api.ts).
 *      Holding that lock for the length of a multi-gigabyte copy would
 *      freeze every request behind it — the exact frozen window §16 says
 *      the progress bar exists to avoid. A second connection to the same
 *      WAL-mode file sidesteps the question entirely: in WAL mode a reader
 *      does not block a writer, so the application carries on writing while
 *      this reads.
 *
 * The copy still sees those writes. That is the property the whole feature
 * rests on and it is asserted directly in backup/backup.spec.ts: rows
 * committed while the copy is in flight come back out of the copy, and the
 * same rows are MISSING from a `fs.copyFileSync` of the same `.db` taken at
 * the same moment.
 *
 * @returns the number of pages copied.
 */
export async function copyDatabaseFile(options: CopyDatabaseOptions): Promise<number> {
  const source = openSqliteDatabase({
    filename: options.sourceFile,
    enableForeignKeyConstraints: false,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    readOnly: true,
  });

  let pinned = false;
  try {
    pinned = pinReadSnapshot(source);
    return await backupSqliteDatabase(source, options.destination, {
      rate: options.rate,
      onProgress: options.onProgress,
    });
  } finally {
    if (pinned) releaseReadSnapshot(source);
    source.close();
  }
}

/**
 * Opens a read transaction on the source and holds it for the whole copy.
 *
 * *** WITHOUT THIS, A BACKUP OF A BUSY DATABASE MAY NEVER FINISH. *** This
 * is not a tuning detail; it is the difference between the feature working
 * and the feature hanging, and it was found by measurement rather than
 * reasoning.
 *
 * SQLite's rule: if the source is modified through a connection OTHER than
 * the one the backup is reading, the next `sqlite3_backup_step()` RESTARTS
 * the copy from the beginning. Not resumes — restarts. We deliberately read
 * through a second, read-only connection (see the function above for why),
 * so every write the application makes while the copy runs is exactly that
 * kind of external modification.
 *
 * Measured on a 60,000-row database with one insert per millisecond:
 *
 *   unpinned   62 restarts, still not finished after 10 seconds
 *   pinned      0 restarts, finished in 102 ms
 *
 * On the owner's ~600 MB collection the unpinned behaviour would mean a
 * backup that restarts at 90% because somebody edited a grade, over and
 * over, for as long as they keep using the app.
 *
 * A read transaction fixes it because it pins a SNAPSHOT. In WAL mode a
 * reader holding one sees a fixed view of the database while writers carry
 * on appending, so the source the backup is reading never changes and there
 * is nothing to restart for. It also makes the backup's consistency
 * explicit rather than incidental: the file is the collection exactly as it
 * stood at this instant, not a blend of several.
 *
 * THE COST, STATED HONESTLY: the WAL cannot be checkpointed while the
 * snapshot is held, so it grows by whatever is written during the copy.
 * That is disk space, temporarily, on a database being actively edited
 * during a backup — against a copy that might never complete.
 *
 * `BEGIN` on its own is DEFERRED and starts nothing; the read transaction
 * only opens on the first actual read. The `SELECT` is therefore not
 * decorative, and removing it would silently restore the broken behaviour.
 */
function pinReadSnapshot(source: SqliteDatabase): boolean {
  try {
    source.exec('BEGIN');
    source.prepare('SELECT COUNT(*) AS n FROM sqlite_master').all();
    return true;
  } catch {
    // A backup that restarts occasionally is far better than no backup, so
    // a failure to pin is not fatal — it is the old behaviour.
    return false;
  }
}

function releaseReadSnapshot(source: SqliteDatabase): void {
  try {
    // Nothing was written, so COMMIT and ROLLBACK are the same thing here.
    // ROLLBACK is used because it cannot be misread as "and now save it".
    source.exec('ROLLBACK');
  } catch {
    // Closing the connection releases it regardless.
  }
}

/**
 * Writes the `backup.*` rows into a FINISHED copy.
 *
 * WHY THE METADATA GOES IN THE FILE AND NOT BESIDE IT. A sidecar `.json`
 * is one drag-and-drop away from being separated from the database it
 * describes, and then the user has two files, one of which is a lie. The
 * file modification time is no better: copying a backup onto a USB stick
 * and back can rewrite it, and "when was this taken" is exactly the
 * question a user asks when they are looking at two files and trying to
 * tell them apart.
 *
 * WHY AppSettings AND NOT A NEW TABLE. A new table would not exist in
 * db/schema.sql, so a restored database would carry a table the schema does
 * not describe — and db/schema.spec.ts asserts the exact table list, which
 * is a check worth keeping sharp. AppSettings is already a key/value store
 * with a documented prefix convention, and the rows are visible to anyone
 * who opens the file in a SQLite browser, which is the right level of
 * discoverability for a provenance stamp.
 *
 * WHY AFTER THE COPY AND NOT BEFORE. Writing them into the LIVE database
 * first and letting the copy carry them would mean the application's own
 * database permanently claims to be a backup of itself. The copy is written
 * to instead, once, when it is complete.
 */
export function writeBackupMetadata(filePath: string, entries: Record<string, string>): void {
  const database = openSqliteDatabase({
    filename: filePath,
    enableForeignKeyConstraints: false,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
  });

  try {
    const statement = database.prepare(
      'INSERT INTO AppSettings (SettingKey, SettingValue) VALUES (@key, @value) ' +
        'ON CONFLICT (SettingKey) DO UPDATE SET SettingValue = excluded.SettingValue'
    );
    for (const [key, value] of Object.entries(entries)) {
      statement.run({ key, value });
    }
    // The copy is WAL-mode, because journal mode is a property of the file
    // and `backup()` reproduces it. Left alone deliberately: switching it to
    // DELETE here would produce a file whose journal mode differs from the
    // one it is a backup OF, and the sidecars a WAL file creates when opened
    // are transient and recreated on demand. What matters is that the `.db`
    // is self-contained the moment this handle closes, which it is.
  } finally {
    database.close();
  }
}
