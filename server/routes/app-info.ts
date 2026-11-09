/**
 * routes/app-info.ts — GET /api/app-info
 *
 * Supplies the batch image import screen with a prefill for the one thing the
 * browser refuses to tell it: the absolute folder the user's coin photos live
 * in. (A directory picker hands JavaScript only `File.webkitRelativePath` —
 * the path RELATIVE to the folder picked, never the real location on disk. See
 * src/app/services/image-import/source-path.ts.)
 *
 * A HARDCODED guess is the dangerous option: a path valid on another machine
 * does not fail loudly, it stamps every imported row with a location that
 * resolves to nothing. So the prefill is something only the server can know
 * and that is guaranteed to be a real, host-local path: the folder the app
 * itself is installed in. It is probably not where the photos are, and the
 * import screen says so, but it is the right shape on the right machine with
 * the right drive letter. Once the user edits it the choice is remembered
 * (src/app/services/image-import/import-base-folder.ts) and this endpoint's
 * answer is never used again.
 *
 * THIS ROUTER NEVER TOUCHES THE DATABASE, deliberately: it answers a question
 * about the filesystem, not about coins, so it still answers correctly when
 * SQL Server is down. The import screen must open even in a half-broken state,
 * and a cosmetic default is never worth failing a page load over.
 *
 * 200 => { appFolder: 'D:\\CoinInventory', source: 'module' }
 */

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { logWarn } from '../logger';

/**
 * How the answer was arrived at. Returned alongside the path purely as a
 * debugging aid — if the prefill ever looks wrong on the host, this says
 * immediately whether the environment variable was picked up, whether the
 * project root was found, or whether we fell all the way through to the
 * working directory.
 */
export type AppFolderSource = 'env' | 'module' | 'cwd';

export interface AppInfo {
  /** Absolute, Windows-style path of the folder the app is installed in. */
  appFolder: string;
  source: AppFolderSource;
}

/**
 * The escape hatch, documented in server/README.md's `.env` section. An
 * unusual deployment — unpacked somewhere odd, run through a symlink, started
 * as a service with a working directory of `C:\Windows\System32` — can leave
 * the derivation below with a defensible but unhelpful answer. Rather than add
 * guesswork for those cases, one variable overrides the whole thing.
 */
const OVERRIDE_ENV_VAR = 'APP_BASE_FOLDER';

/**
 * The file that marks the project root.
 *
 * `angular.json` is the right marker precisely because it exists at the root and
 * NOT in `server/`. `package.json` would be ambiguous — there is one in both
 * places — and picking the wrong one would silently report `<root>\server`.
 */
const ROOT_MARKER = 'angular.json';

/**
 * How far up from this module we are willing to walk looking for the marker.
 *
 * Three would do for the two layouts shipped (see `deriveFolderFromModule`);
 * six is slack for a future reshuffle. Bounded rather than "walk to the
 * filesystem root" so a missing marker cannot turn into a long stat-storm
 * across a network drive.
 */
const MAX_LEVELS_UP = 6;

/**
 * Normalise a path into the Windows shape the rest of this feature speaks.
 *
 * The import screen glues this value onto `File.webkitRelativePath` with a
 * single backslash (see source-path.ts), so what it gets back needs to be
 * consistent: backslash separators, no repeated separators, and no trailing
 * separator to double up on.
 *
 * The separator rewriting only happens for paths that really are Windows paths —
 * a drive letter (`D:\...`) or a UNC prefix (`\\host\share`). That guard exists
 * so this is not actively wrong if the code is ever run on a POSIX box (the
 * specs, for instance, can run anywhere): turning `/opt/app` into `\opt\app`
 * would be worse than leaving it alone.
 */
export function normaliseWindowsPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  const looksWindows = /^[a-zA-Z]:/.test(trimmed) || /^[\\/]{2}/.test(trimmed);
  if (!looksWindows) return trimmed;

  // Remember whether this was a UNC path BEFORE collapsing separators, because
  // the leading `\\` is the one doubled separator that has to survive.
  const isUnc = /^[\\/]{2}/.test(trimmed);

  let result = trimmed.replace(/\//g, '\\');
  result = result.replace(/\\{2,}/g, '\\');
  if (isUnc) result = `\\${result}`;

  // Strip a trailing separator, but never turn a drive root into a bare `D:`
  // (which Windows reads as "the current directory on D:", not "the root of D:").
  if (result.length > 3 || !/^[a-zA-Z]:\\$/.test(result)) {
    result = result.replace(/\\+$/, '');
  }

  return result;
}

/**
 * Walk up from this module's own directory looking for the project root.
 *
 * THE TRAP: tsx vs. compiled dist. This file runs from two different depths,
 * so any fixed `path.resolve(__dirname, '..', '..')` is wrong in one of them:
 *
 *   under tsx      __dirname = <root>\server\routes       -> 2 levels up
 *   compiled       __dirname = <root>\server\dist\routes  -> 3 levels up
 *                  (server/tsconfig.json has outDir ./dist, rootDir ., so the
 *                   tree is mirrored one level deeper)
 *
 * Hardcoding either number gives a plausible-looking path that is off by a
 * folder, and silently wrong is exactly the failure this feature exists to
 * avoid. So instead of counting levels we LOOK for the root: climb until a
 * directory contains `angular.json`. One code path, no build-mode detection,
 * and it stays correct if the output layout changes again.
 *
 * Returns null when the marker is nowhere to be found, which is the caller's
 * cue to fall through to `process.cwd()`.
 */
function deriveFolderFromModule(): string | null {
  let dir = __dirname;

  for (let level = 0; level <= MAX_LEVELS_UP; level++) {
    try {
      if (fs.existsSync(path.join(dir, ROOT_MARKER))) return dir;
    } catch {
      // existsSync can still throw on a genuinely malformed path (illegal
      // characters, a dead network share). Not finding the marker here is not
      // fatal — keep climbing, and let the caller fall back if nothing matches.
    }

    const parent = path.dirname(dir);
    // path.dirname of a root ('C:\' or '/') returns itself, so this is the
    // "we have run out of parents" test.
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Work out the folder the app is installed in, most explicit source first:
 *
 *   1. the APP_BASE_FOLDER environment variable, if set to something non-blank;
 *   2. the project root found by walking up from this module (see above);
 *   3. `process.cwd()` as a last resort.
 *
 * Step 3 is deliberately last and deliberately present. It is the weakest
 * answer — the launcher starts the backend from `server/`, so cwd is
 * `<root>\server` — but "a real folder on the host, one level too deep" is
 * still a usable starting point, and it guarantees this function always has
 * something to return. A blank answer would be indistinguishable from the
 * endpoint being broken.
 *
 * Exported so the specs can exercise the resolution order without HTTP.
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

  // Worth a log line: it means the marker file was not found anywhere above
  // this module, which is unexpected enough to be useful when diagnosing an
  // odd-looking prefill on the host.
  logWarn(
    `app-info: could not locate ${ROOT_MARKER} above ${__dirname}; ` +
    `falling back to the working directory`
  );
  return { appFolder: normaliseWindowsPath(process.cwd()), source: 'cwd' };
}

const router = Router();

router.get('/app-info', (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Resolved per request rather than cached at module load, so an
    // APP_BASE_FOLDER set after startup is honoured without a restart. The
    // cost is a handful of existsSync calls on a local path, once per import
    // screen.
    res.json(resolveAppFolder());
  } catch (err) {
    // resolveAppFolder() is written not to throw, so reaching here means
    // something genuinely unexpected happened.
    next(err);
  }
});

export default router;
