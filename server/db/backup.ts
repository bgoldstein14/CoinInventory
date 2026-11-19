/**
 * File-level database operations for backup and restore. They live in db/
 * because only the data layer may hold a SQLite handle
 * (db/driver-isolation.spec.ts); callers get plain data back.
 *
 *   copyDatabaseFile()       consistent copy of the live database (online backup API)
 *   readDatabaseFileFacts()  open a candidate file read-only and report its contents
 *   writeBackupMetadata()    stamp a finished copy with what it contains
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

/** The first 16 bytes of every SQLite file, checked before opening so a wrong file gets a clear message. */
export const SQLITE_FILE_HEADER = 'SQLite format 3\u0000';

/** How many bytes to read to decide whether a file is SQLite at all. */
const HEADER_BYTES = 16;

/**
 * True if the file starts with the SQLite header. Zero-length files are
 * rejected: SQLite would happily open one as an empty database.
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
  /** Photographs whose image data is stored inside the file. */
  readonly storedImageCount: number | null;
  /**
   * Photographs with only a SourcePath, which may not exist on the machine
   * doing the restore. backup/inspect.ts warns about these.
   */
  readonly referencedOnlyImageCount: number | null;
  /** The distinct folders those SourcePaths point into, capped. */
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

/** Cap on folders reported. */
const REFERENCED_FOLDER_LIMIT = 12;

/** The AppSettings key prefix a backup stamps itself with. */
export const BACKUP_METADATA_PREFIX = 'backup.';

/**
 * Opens `filePath` read-only and reports what is in it. Read-only matters:
 * a read-write open can roll back a hot journal or rewrite the header of a
 * file the user has not agreed to restore yet. Throws if the file cannot be
 * opened; backup/inspect.ts turns that into a verdict.
 */
export function readDatabaseFileFacts(filePath: string): DatabaseFileFacts {
  return withoutLeavingSidecars(filePath, () => {
    const database = openSqliteDatabase({
      filename: filePath,
      // Off so pre-existing orphan rows don't make the inspection itself fail.
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
 * Runs `work`, then removes any `-wal` / `-shm` files this call created.
 * Opening a WAL database, even read-only, creates them and a read-only handle
 * can't clean them up. Sidecars that already existed are left alone: a
 * pre-existing `-wal` can hold committed data.
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
        // Best effort; a leftover sidecar shouldn't fail the inspection.
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
    // IS NOT NULL rather than LENGTH > 0, so an empty value (an upstream bug) isn't hidden.
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
 * Splits on both separators instead of path.dirname, because the stored paths
 * are Windows paths and this may run on POSIX (e.g. CI).
 */
export function distinctFolders(sourcePaths: readonly string[]): string[] {
  const seen = new Set<string>();

  for (const raw of sourcePaths) {
    const value = raw.trim();
    if (value.length === 0) continue;

    const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
    // A bare file name has no folder to report.
    if (cut <= 0) continue;

    seen.add(value.slice(0, cut));
    if (seen.size >= REFERENCED_FOLDER_LIMIT) break;
  }

  return [...seen].sort();
}

/** Everything copyDatabaseFile() needs. */
export interface CopyDatabaseOptions {
  /** The live database file to copy. Never ':memory:'. */
  readonly sourceFile: string;
  /** Where the copy goes. Its directory must already exist. */
  readonly destination: string;
  /** Pages per batch. See db/driver.ts's SqliteBackupOptions. */
  readonly rate: number;
  /** Called after each batch. Throwing from it cancels the backup. */
  readonly onProgress: (progress: SqliteBackupProgress) => void;
}

/**
 * Copies the live database to `destination` while the app keeps running.
 * Uses its own read-only source handle rather than the app's: it can't damage
 * the source, and it avoids holding the shared connection lock for the whole
 * copy (in WAL mode a reader doesn't block writers). Writes committed during
 * the copy are included (see backup/backup.spec.ts).
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
 * Without it, SQLite restarts the backup from the beginning whenever another
 * connection writes to the source, so a backup of a busy database may never
 * finish (measured: 62 restarts and unfinished after 10 s, versus 0 restarts
 * and 102 ms pinned). The pinned snapshot also makes the copy a consistent
 * point-in-time view. Cost: the WAL can't be checkpointed meanwhile and grows.
 *
 * BEGIN is deferred, so the SELECT is what actually opens the read
 * transaction; it is required.
 */
function pinReadSnapshot(source: SqliteDatabase): boolean {
  try {
    source.exec('BEGIN');
    source.prepare('SELECT COUNT(*) AS n FROM sqlite_master').all();
    return true;
  } catch {
    // Not fatal: the backup still works, it just may restart.
    return false;
  }
}

function releaseReadSnapshot(source: SqliteDatabase): void {
  try {
    // Nothing was written; ROLLBACK just ends the read transaction.
    source.exec('ROLLBACK');
  } catch {
    // Closing the connection releases it anyway.
  }
}

/**
 * Writes the `backup.*` rows into AppSettings of a finished copy. Stored in
 * the file (not a sidecar or file mtime) so the metadata can't be separated
 * from the backup, and in AppSettings so the schema needs no extra table.
 * Written to the copy, never the live database.
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
    // Journal mode is left as WAL to match the source; the .db is
    // self-contained once this handle closes.
  } finally {
    database.close();
  }
}
