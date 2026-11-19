 /*
 * base-folder-check.ts — refuse an import whose paths resolve to nothing.
 *
 * A directory picker only supplies paths relative to the chosen folder; the
 * absolute prefix comes from the base-folder text box (see source-path.ts).
 * If that box holds the wrong root, every stored path is dead. Before writing,
 * a sample of the paths is checked via POST /api/images/exists.
 *
 * Rules:
 *   1. Only a total failure blocks. The files were just picked, so a wrong
 *      root fails every path; a few failures are individual and don't block.
 *   2. Fails open: if the check can't run, the import proceeds.
 *   3. No base folder is not an error; paths are simply not recorded.
 *
 * The probe is injected so this stays testable without HTTP or a DOM.
  */

import { sourcePathForFile } from './source-path';

/**
 * How many of the selected files are checked. The failure is all-or-nothing
 * (rule 1), so a few samples are enough.
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

/** Resolves to a `path -> boolean` map, as `POST /api/images/exists` returns. */
export type PathExistenceProbe = (paths: string[]) => Promise<Record<string, boolean>>;

/**
 * The absolute paths that would be stored for a sample of the selection.
 * Spread across the selection, since the first few files are usually in one
 * subfolder. De-duplicated.
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
 * Decide whether this import may write paths. `ok: false` only when every
 * checked path came back explicitly unreadable.
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
    // Rule 2: fail open.
    return { ok: true, reason: 'check-failed', checked };
  }

  // A path absent from the response is unknown, not missing.
  const anyReadable = checked.some(path => results[path] !== false);

  return anyReadable
    ? { ok: true, reason: 'verified', checked }
    : { ok: false, reason: 'unreadable', checked };
}

/**
 * The message to show the user, or null. Names a real failing path so the
 * mistake is obvious.
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
