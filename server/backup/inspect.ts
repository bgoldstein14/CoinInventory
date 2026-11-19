/**
 * Inspects a candidate restore file without changing it. backup/verdict.ts
 * decides whether it may be restored; this also reports what the user needs
 * to decide whether it should be: coin count, date taken, and whether its
 * photos will be available.
 *
 * Photos stored in 'referenced' mode are only a SourcePath into a folder on
 * the machine that imported them, so their folders are checked against this
 * machine and missing ones reported before the restore.
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
  /** The resolved path, echoed back. */
  readonly path: string;
  /** Size on disk, or null when there is no file. */
  readonly fileSizeBytes: number | null;
  /** The decision, and the sentence that goes with it. */
  readonly decision: RestoreDecision;
  /** Null for anything that did not open. */
  readonly schemaVersion: number | null;
  /** Coins in the file, counted now. */
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
 * Inspects a file. A bad file (folder, renamed JPEG, half-copied or foreign
 * database) is an answer, not an exception. Throws only for unexpected
 * failures, such as a permissions error on stat.
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
      // A verdict, not a server fault. The text is kept for the log.
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
 * Which photo folders exist on this machine. Checks folders, not files: a
 * missing folder is what happens when a database moves to another PC, and it
 * keeps this to a handful of stat calls.
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
