 /*
 * Rebuilds the original file's absolute path for `CoinImages.SourcePath`.
 *
 * Browsers never expose a picked file's real path. A directory picker gives
 * only `File.webkitRelativePath`, relative to the picked folder and with
 * forward slashes ("Coin Pictures/Business Strikes/1865 3CN - Obverse.jpg").
 * The user supplies the base folder once, and the two are joined.
 *
 * The path is resolved by the backend (server/routes/images/), so it must be
 * valid on the machine hosting the server, not just the user's workstation.
 *
 * Never hardcode a base folder: a wrong one silently stamps every row with a
 * dead path. The user's saved choice wins (see import-base-folder.ts).
  */

/** Illustrative path for placeholder/hint text only; never used as a value. */
export const EXAMPLE_IMPORT_BASE_FOLDER = 'D:\\Coin Pictures';

const SEPARATOR = '\\';

/** Convert to Windows separators and trim (pasted paths often carry whitespace). */
function toWindowsSeparators(value: string): string {
  return value.trim().replace(/\//g, SEPARATOR);
}

/**
 * Strip trailing separators from the base folder so joining doesn't double
 * them. Only the end is touched (a UNC `\\` prefix is safe); an all-separator
 * base is left as is.
 */
function stripTrailingSeparators(base: string): string {
  const stripped = base.replace(/[\\/]+$/, '');
  return stripped.length > 0 ? stripped : base;
}

/** Split a normalised path into its non-empty segments. */
function segmentsOf(path: string): string[] {
  return path.split(SEPARATOR).filter(segment => segment.length > 0);
}

/**
 * Join the user's base folder to a browser-supplied relative path, giving an
 * absolute Windows path.
 *
 *  1. Both halves are trimmed and converted to backslashes.
 *  2. Exactly one separator ends up between them.
 *  3. If the base's last folder equals the relative path's first folder, the
 *     duplicate is dropped. `webkitRelativePath` includes the picked folder's
 *     name, so picking `\\NAS\Coin Pictures` with that as the base would
 *     otherwise give `...\Coin Pictures\Coin Pictures\...`. A real same-named
 *     subfolder would lose a level; the screen's live preview lets the user catch it.
 *  4. An empty half returns the other half alone.
 */
export function joinWindowsPath(baseFolder: string, relativePath: string): string {
  const base = stripTrailingSeparators(toWindowsSeparators(baseFolder ?? ''));
  const relative = toWindowsSeparators(relativePath ?? '').replace(/^[\\/]+/, '');

  if (base.length === 0) return relative;
  if (relative.length === 0) return base;

  const baseSegments = segmentsOf(base);
  const relativeSegments = segmentsOf(relative);

  // Rule 3, case-insensitive as Windows paths are.
  const lastOfBase = baseSegments[baseSegments.length - 1];
  const firstOfRelative = relativeSegments[0];
  if (
    baseSegments.length > 0 &&
    relativeSegments.length > 1 &&
    lastOfBase.toLowerCase() === firstOfRelative.toLowerCase()
  ) {
    relativeSegments.shift();
  }

  return `${base}${SEPARATOR}${relativeSegments.join(SEPARATOR)}`;
}

/**
 * The absolute path to record for one picked file, or null without a base
 * folder ("no path recorded"). Uses `webkitRelativePath`, or `file.name` for a
 * plain multi-file pick.
 */
export function sourcePathForFile(baseFolder: string, file: File): string | null {
  // Without a base folder, record nothing: a bare relative path would be
  // resolved against the server's working directory.
  if (!baseFolder || baseFolder.trim().length === 0) return null;

  const relative = file.webkitRelativePath || file.name;
  const joined = joinWindowsPath(baseFolder, relative);
  return joined.length > 0 ? joined : null;
}

/*
 * Comparing stored paths ("is this file already attached to that coin?").
 * The same file can be written with different case, slash direction, trailing
 * separators or doubled separators (older rows), so both sides are normalised.
 * No filesystem resolution (`..`, 8.3 names, mapped drives) is attempted. When
 * in doubt this errs towards not matching: a miss re-attaches a photo, a false
 * match would skip one the user wanted.
 */

/**
 * The normal form used to compare two source paths. Returns `''` for
 * null/blank ("no path recorded"); callers must treat `''` as unknown, never
 * as a match.
 */
export function normalizeSourcePathForComparison(path: string | null | undefined): string {
  if (!path) return '';

  const windows = toWindowsSeparators(path);

  // Keep the UNC "\\" prefix aside so the collapse below can't remove it.
  const isUnc = windows.startsWith(SEPARATOR + SEPARATOR);
  const body = isUnc ? windows.slice(2) : windows;

  const collapsed = body
    .replace(/\\+/g, SEPARATOR)   // ...Pictures\\Business -> ...Pictures\Business
    .replace(/\\+$/, '');         // a trailing separator names the same folder

  const normalized = (isUnc ? SEPARATOR + SEPARATOR + collapsed : collapsed).toLowerCase();

  // Only separators/whitespace: treat as "unknown", like null.
  return normalized === SEPARATOR || normalized === SEPARATOR + SEPARATOR ? '' : normalized;
}

/**
 * The finished path for the first selected file, shown on the import screen so
 * the user can check the base folder before anything is written.
 */
export function previewSourcePath(baseFolder: string, file: File | undefined): string | null {
  if (!file) return null;
  return sourcePathForFile(baseFolder, file);
}
