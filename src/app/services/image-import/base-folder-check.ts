/* ===========================================================================
 * base-folder-check.ts — refuse an import whose paths resolve to nothing.
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ---------------------------------------------------------------------------
 * The owner imported a folder of photos and every row came back stamped with a
 * path under his DEVELOPMENT folder rather than the folder he had picked —
 * "making up directories under Development by denomination".
 *
 * Nothing was made up. A browser never tells JavaScript where a file really
 * lives (the long version is in source-path.ts); a directory picker supplies
 * only `webkitRelativePath`, the path RELATIVE to the chosen folder. The
 * absolute prefix therefore comes from exactly one place — the base-folder
 * text box — and that box had been left holding its fallback, which is the
 * folder the app itself is installed in. His real subfolder names were glued
 * onto the wrong root, and all of it resolved to nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXISTING DEFENCE WAS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The import screen already renders a live example of the path about to be
 * stored (`BaseFolderState.preview`), built from the first selected file. That
 * was a good idea and it stays. But it is ADVISORY, and the project's own
 * README had already predicted, in these words, what advisory would cost:
 *
 *     "A path valid on the wrong machine is the single most expensive mistake
 *      that screen can make, because it does not fail loudly -- it stamps
 *      every imported row with a location that resolves to nothing."
 *
 * A hint the user is under no obligation to read is not a defence against a
 * silent 1,700-row mistake. So the paths that WOULD be written are now checked
 * against the disk first, through the same `POST /api/images/exists` endpoint
 * the inventory grid already uses to cross out missing files, and an import
 * that would record nothing but dead paths is refused.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RULES THAT KEEP THIS FROM BECOMING ITS OWN BUG
 * ---------------------------------------------------------------------------
 * 1. ONLY A TOTAL FAILURE BLOCKS. The user picked these files moments ago, so
 *    they exist. If the root is wrong, EVERY path fails. A few failures mean
 *    something individual happened and is not grounds to refuse the rest.
 *
 * 2. IT FAILS OPEN. If the check itself cannot run, the import proceeds. This
 *    is a safety net, not a dependency: blocking a legitimate import because a
 *    diagnostic endpoint hiccupped would leave the user with no way forward at
 *    all, which is worse than the bug being prevented.
 *
 * 3. AN ABSENT BASE FOLDER IS NOT AN ERROR. Importing without recording paths
 *    is a legitimate, long-standing choice — `sourcePathForFile` returns null
 *    and the screen shows its own warning. That path must stay open.
 *
 * Plain functions with an injected probe rather than an ApiService dependency,
 * for the same reason `import-base-folder.ts` takes an `AppFolderProvider`:
 * this stays unit-testable under Node with no DOM and no HTTP mock.
 * =========================================================================== */

import { sourcePathForFile } from './source-path';

/**
 * How many of the selected files are checked.
 *
 * One request, capped well under the endpoint's own 500-path limit. Five is
 * enough because of rule 1 above: the failure this detects is all-or-nothing,
 * so a handful of samples distinguishes it as reliably as a thousand would,
 * and the check has to be cheap enough to run on every import without anyone
 * noticing it.
 */
export const MAX_SAMPLED_PATHS = 5;

/** Why a verdict came out the way it did. Surfaced for logging and tests. */
export type VerdictReason =
  | 'verified'         // paths were checked and at least one resolved
  | 'unreadable'       // paths were checked and NONE resolved -> block
  | 'no-base-folder'   // nothing to anchor names to; not an error (rule 3)
  | 'nothing-selected' // no files to check
  | 'check-failed';    // the probe could not answer (rule 2)

export interface BaseFolderVerdict {
  /** False ONLY when the import must be refused. */
  ok: boolean;
  reason: VerdictReason;
  /** The paths actually sent to the probe, so a message can name one. */
  checked: string[];
}

/**
 * How existence is established. Resolves to a `path -> boolean` map, exactly
 * the shape `POST /api/images/exists` returns.
 */
export type PathExistenceProbe = (paths: string[]) => Promise<Record<string, boolean>>;

/**
 * The absolute paths that WOULD be stored for a sample of the selection.
 *
 * WHY THE SAMPLE IS SPREAD AND NOT THE FIRST N
 * A selection arrives in directory order, so the first five files are usually
 * all in the same subfolder. Checking those would verify one corner of the
 * tree and pronounce the whole import sound. Spreading across the selection
 * touches the start, the end and the middle for the same cost.
 *
 * De-duplicated AFTER building, so repeated paths cannot eat the cap.
 */
export function samplePathsToVerify(baseFolder: string, files: readonly File[]): string[] {
  if (!baseFolder || baseFolder.trim().length === 0) return [];
  if (files.length === 0) return [];

  const indices: number[] = [];
  if (files.length <= MAX_SAMPLED_PATHS) {
    for (let i = 0; i < files.length; i++) indices.push(i);
  } else {
    // Evenly spaced, inclusive of both ends.
    for (let i = 0; i < MAX_SAMPLED_PATHS; i++) {
      indices.push(Math.round((i * (files.length - 1)) / (MAX_SAMPLED_PATHS - 1)));
    }
  }

  const paths: string[] = [];
  for (const index of indices) {
    const path = sourcePathForFile(baseFolder, files[index]);
    if (path) paths.push(path);
  }

  return [...new Set(paths)];
}

/**
 * Decide whether this import may write paths.
 *
 * Returns `ok: false` in exactly one circumstance — paths were checked and
 * every single one came back explicitly unreadable. Everything else, including
 * every kind of failure of the check itself, returns `ok: true`.
 */
export async function verifyBaseFolder(
  baseFolder: string,
  files: readonly File[],
  probe: PathExistenceProbe
): Promise<BaseFolderVerdict> {
  if (!baseFolder || baseFolder.trim().length === 0) {
    return { ok: true, reason: 'no-base-folder', checked: [] };
  }

  const checked = samplePathsToVerify(baseFolder, files);
  if (checked.length === 0) {
    return { ok: true, reason: 'nothing-selected', checked: [] };
  }

  let results: Record<string, boolean>;
  try {
    results = await probe(checked);
  } catch {
    // Rule 2. Deliberately swallowed — see the header.
    return { ok: true, reason: 'check-failed', checked };
  }

  // A path ABSENT from the response is unknown, not missing. The endpoint keys
  // its answer by path and drops anything it could not use, so reading a
  // missing key as `false` would refuse a perfectly good import.
  const anyReadable = checked.some(path => results[path] !== false);

  return anyReadable
    ? { ok: true, reason: 'verified', checked }
    : { ok: false, reason: 'unreadable', checked };
}

/**
 * The message to show the user, or null when there is nothing to say.
 *
 * It names a REAL path rather than describing the problem abstractly. Being
 * told "the folder may be wrong" invites the user to decide it probably is not;
 * being shown `C:\dev\coin-inventory\Half Dollars\1875 20c - Obverse.jpg` when
 * the photos are on `D:` makes the mistake self-evident at a glance.
 */
export function verdictMessage(verdict: BaseFolderVerdict): string | null {
  if (verdict.ok) return null;

  const example = verdict.checked[0] ?? '';
  return (
    `Nothing exists at ${example}\n\n` +
    `These photos would be recorded at a location that cannot be opened, so ` +
    `nothing has been imported. The folder box at the top of this screen sets ` +
    `the start of every stored path, and the folder you pick in the file ` +
    `chooser cannot set it — a browser never reveals where a file really ` +
    `lives. Correct the folder box so the example path matches where your ` +
    `photos actually are, then import again.`
  );
}
