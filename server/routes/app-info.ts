/**
 * GET /api/app-info: the folder the app is installed in, and the user's
 * Documents folder, which prefills the batch image import's folder box until
 * the user sets their own (a browser directory picker only exposes relative
 * paths; see src/app/services/image-import/source-path.ts).
 *
 * Never touches the database, so the import screen still opens when it's down.
 *
 * 200 => { appFolder: 'D:\CoinInventory', source: 'module', documentsFolder: 'C:\Users\me\Documents' }
 */

import { Router, Request, Response, NextFunction } from 'express';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logWarn } from '../logger';

/** How the answer was found (env var, project root, or working directory); for debugging. */
export type AppFolderSource = 'env' | 'module' | 'cwd';

export interface AppInfo {
  /** Absolute, Windows-style path of the folder the app is installed in. */
  appFolder: string;
  source: AppFolderSource;
}

/** Override for unusual deployments (documented in server/README.md). */
const OVERRIDE_ENV_VAR = 'APP_BASE_FOLDER';

/** Marks the project root. Not package.json, which also exists in server/. */
const ROOT_MARKER = 'angular.json';

/** Max levels to walk up looking for the marker, so a missing one can't cause a long stat loop. */
const MAX_LEVELS_UP = 6;

/**
 * Normalizes to the Windows form the import screen expects: backslashes, no
 * repeated or trailing separators. Only applied to drive-letter or UNC paths,
 * so POSIX paths (e.g. in tests) are left alone.
 */
export function normaliseWindowsPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  const looksWindows = /^[a-zA-Z]:/.test(trimmed) || /^[\\/]{2}/.test(trimmed);
  if (!looksWindows) return trimmed;

  // Note UNC before collapsing separators; its leading `\` must survive.
  const isUnc = /^[\\/]{2}/.test(trimmed);

  let result = trimmed.replace(/\//g, '\\');
  result = result.replace(/\\{2,}/g, '\\');
  if (isUnc) result = `\\${result}`;

  // Strip a trailing separator, but keep a drive root as `D:\` (`D:` means the current directory).
  if (result.length > 3 || !/^[a-zA-Z]:\\$/.test(result)) {
    result = result.replace(/\\+$/, '');
  }

  return result;
}

/**
 * Walks up from this module to the folder containing angular.json. The
 * depth differs under tsx (server/routes) and compiled (server/dist/routes),
 * so searching is more reliable than a fixed `..` count. Returns null if not
 * found.
 */
function deriveFolderFromModule(): string | null {
  let dir = __dirname;

  for (let level = 0; level <= MAX_LEVELS_UP; level++) {
    try {
      if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir;
    } catch {
      // existsSync can throw on a malformed path; keep climbing.
    }

    const parent = path.dirname(dir);
    // dirname of a root returns itself: no more parents.
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * The app's install folder, most explicit source first:
 *
 *   1. APP_BASE_FOLDER, if set;
 *   2. the project root found by walking up from this module;
 *   3. process.cwd() (usually `<root>\server`), so there's always an answer.
 *
 * Exported for tests.
 */
export function resolveAppFolder(): AppInfo {
  const override = process.env[OVERRIDE_ENV_VAR];
  if (typeof override === 'string' && override.trim().length > 0) {
    return { appFolder: normaliseWindowsPath(override), source: 'env' };
  }

  const derived = deriveFolderFromModule();
  if (derived) {
    return { appFolder: normaliseWindowsPath(derived), source: 'module' };
  }

  // Unexpected: the marker wasn't found above this module.
  logWarn(
    `app-info: could not locate ${ROOT_MARKER} above ${__dirname}; ` +
    `falling back to the working directory`
  );
  return { appFolder: normaliseWindowsPath(process.cwd()), source: 'cwd' };
}

/** Override for the Documents folder (e.g. set by the desktop shell). */
const DOCUMENTS_ENV_VAR = 'COIN_DOCUMENTS_FOLDER';

/** Windows' own answer, cached: the registry value is read once per process. */
let windowsDocuments: string | null | undefined;

/**
 * The Documents folder Windows reports, which follows a redirect (e.g. to
 * OneDrive). Null when not on Windows or the lookup fails.
 */
function readWindowsDocumentsFolder(): string | null {
  if (windowsDocuments !== undefined) return windowsDocuments;
  windowsDocuments = null;
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true }
    );
    const raw = /Personal\s+REG_\w+\s+(.+)/.exec(output)?.[1]?.trim();
    // Values are stored with %USERPROFILE%-style variables.
    const expanded = raw?.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
    if (expanded && !expanded.includes('%') && fs.existsSync(expanded)) windowsDocuments = expanded;
  } catch {
    // reg.exe missing or blocked: fall back below.
  }
  return windowsDocuments;
}

/**
 * The user's Documents folder, the default for the image import's folder box:
 * COIN_DOCUMENTS_FOLDER if set, else what Windows reports, else <home>\Documents.
 */
export function resolveDocumentsFolder(): string {
  const override = process.env[DOCUMENTS_ENV_VAR];
  if (typeof override === 'string' && override.trim().length > 0) {
    return normaliseWindowsPath(override);
  }
  return normaliseWindowsPath(readWindowsDocumentsFolder() ?? path.join(os.homedir(), 'Documents'));
}

const router = Router();

router.get('/app-info', (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Resolved per request so a later override is honoured without restart.
    res.json({ ...resolveAppFolder(), documentsFolder: resolveDocumentsFolder() });
  } catch (err) {
    // resolveAppFolder() shouldn't throw; this is unexpected.
    next(err);
  }
});

export default router;
