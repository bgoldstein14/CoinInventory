/**
 * backup/inspect.ts — LOOK AT THE FILE, CHANGE NOTHING.
 *
 * The first half of restore, and the half the user sees first. It answers
 * two questions about a file they have pointed at:
 *
 *   MAY this replace my collection?   -> backup/verdict.ts decides
 *   SHOULD it?                        -> the user decides, from what is
 *                                        reported here
 *
 * The second question is why this module exists at all rather than the
 * route calling classifyRestoreCandidate() directly. "Yes, that is a valid
 * backup" is not enough to make an irreversible decision on. The user needs
 * to recognise the file: how many coins, taken when, and — the one that
 * only matters because the file is PORTABLE — whether its photographs are
 * going to be there afterwards.
 *
 * *** THE REFERENCED-PHOTO WARNING IS NOT A NICETY. ***
 * §16 names it as one of two consequences of portability to HANDLE rather
 * than discover. There are two image storage modes: 'stored' puts a reduced
 * copy of each photograph inside the database, and 'referenced' records
 * only a `SourcePath` into a folder on the machine the import ran on. A
 * referenced collection carried to another PC is a grid of broken pictures,
 * and the user finds out AFTER the restore, with their old database already
 * moved aside, and has no idea whether the backup is bad or the app is.
 *
 * So the folders are checked against THIS machine's disk, before the
 * restore, and the count of photographs that will not resolve is reported
 * with the folders they wanted. The repair tool that would relocate them
 * (design §4.4) is not built, and this does not pretend otherwise — it says
 * what will be missing and that the entries, not the coins, are what breaks.
 */

import fs from 'fs';

import { looksLikeSqliteFile, readDatabaseFileFacts, type DatabaseFileFacts } from '../db';
import { readBackupProvenance, type BackupProvenance } from './metadata';
import { classifyRestoreCandidate, type RestoreDecision } from './verdict';

/** One folder a backup's photographs point into, and whether it is here. */
export interface ReferencedFolder {
  readonly folder: string;
  /** Does that folder exist on the machine running this check? */
  readonly presentOnThisMachine: boolean;
}

/** Everything the restore dialog needs to show before the user commits. */
export interface BackupInspection {
  /** The path as resolved. Echoed back so the dialog cannot mis-report it. */
  readonly path: string;
  /** Size on disk, or null when there is no file. */
  readonly fileSizeBytes: number | null;
  /** The decision, and the sentence that goes with it. */
  readonly decision: RestoreDecision;
  /** Null for anything that did not open. */
  readonly schemaVersion: number | null;
  /** Coins IN THE FILE, counted now. Not the number the file claims. */
  readonly coinCount: number | null;
  /** Photographs in the file. */
  readonly imageCount: number | null;
  /** Photographs whose picture travels inside the file. */
  readonly storedImageCount: number | null;
  /** Photographs that are only a path, and will break on another machine. */
  readonly referencedOnlyImageCount: number | null;
  /** The folders those paths point into, and whether each one is here. */
  readonly referencedFolders: readonly ReferencedFolder[];
  /** What the file says about itself; all nulls for an old backup. */
  readonly provenance: BackupProvenance;
}

/**
 * Inspects a file. Never throws for a bad file — a bad file is an ANSWER.
 *
 * Every failure mode here is something a user can do with a file picker and
 * a typo, so none of them is exceptional: a path that is a folder, a JPEG
 * renamed to `.db`, a half-copied database, somebody else's SQLite file. An
 * exception thrown out of this function would become a 500 and a red box
 * saying "something went wrong", where what the user needs is a sentence
 * telling them which of those it was.
 *
 * It throws only for a genuinely unexpected failure (a permissions error on
 * `stat`, say), which the route turns into a 500 because that IS one.
 */
export function inspectBackupFile(filePath: string): BackupInspection {
  const fileExists = existsAsFile(filePath);
  const fileSizeBytes = fileExists ? fs.statSync(filePath).size : null;
  const looksSqlite = fileExists && looksLikeSqliteFile(filePath);

  let facts: DatabaseFileFacts | null = null;
  let openError: string | null = null;

  if (looksSqlite) {
    try {
      facts = readDatabaseFileFacts(filePath);
    } catch (err) {
      // Caught, not propagated: "SQLite says the file is encrypted or is not
      // a database" is a verdict, not a server fault. The text is kept for
      // the log; the user gets verdict.ts's sentence instead.
      openError = err instanceof Error ? err.message : String(err);
    }
  }

  const decision = classifyRestoreCandidate({
    fileExists,
    looksLikeSqlite: looksSqlite,
    openError,
    tables: facts?.tables ?? [],
    schemaVersion: facts?.schemaVersion ?? null,
  });

  return {
    path: filePath,
    fileSizeBytes,
    decision,
    schemaVersion: facts?.schemaVersion ?? null,
    coinCount: facts?.coinCount ?? null,
    imageCount: facts?.imageCount ?? null,
    storedImageCount: facts?.storedImageCount ?? null,
    referencedOnlyImageCount: facts?.referencedOnlyImageCount ?? null,
    referencedFolders: checkFolders(facts?.referencedFolders ?? []),
    provenance: readBackupProvenance(facts?.metadata ?? {}),
  };
}

/**
 * Which of the photograph folders exist on THIS machine.
 *
 * Folders rather than individual files, and that is the whole trick. A
 * collection with 3,000 referenced photographs has perhaps four folders,
 * so this is four `statSync` calls instead of three thousand — and a
 * missing FOLDER is the thing that actually happens when a database moves
 * to another PC. A photo missing from a folder that IS there is a different
 * problem with a different fix, and claiming to have checked for it would
 * be a lie about how long this took.
 */
function checkFolders(folders: readonly string[]): ReferencedFolder[] {
  return folders.map((folder) => ({
    folder,
    presentOnThisMachine: existsAsDirectory(folder),
  }));
}

function existsAsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function existsAsDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
