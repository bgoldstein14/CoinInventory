 /*
 * source-path.ts — reconstructing the ORIGINAL file's absolute path.
 *
 * WHY THIS FILE HAS TO EXIST AT ALL (read this before changing anything here)
 *
 * A browser NEVER tells JavaScript where a file really lives on disk. This is
 * a deliberate, non-negotiable security rule: if a web page could read
 * `C:\Users\you\...` out of a file picker it would learn your username, your
 * folder layout and quite a lot else, so the platform simply does not expose
 * it. `file.path` does not exist, and `input.value` reads back the fake
 * `C:\fakepath\whatever.jpg`.
 *
 * What we DO get from a directory picker (`<input type="file" webkitdirectory>`)
 * is `File.webkitRelativePath` — the path of the file *relative to the folder
 * the user picked*, always with forward slashes:
 *
 *     "Coin Pictures/Business Strikes/1865 3CN - MS60 - Obverse.jpg"
 *
 * That is the back half of the answer. The front half — "and that folder was
 * `D:\Coin Pictures`" — is something only the user knows, so the import screen
 * asks them for it once and remembers it. Glue the two halves together and you
 * have the absolute path we can store in `CoinImages.SourcePath`.
 *
 * Individually-picked files (a plain multi-file picker rather than a directory
 * one) have an EMPTY `webkitRelativePath`, so we fall back to `File.name`.
 *
 * WHOSE MACHINE IS THIS PATH FOR?
 *
 * The stored path is resolved by the BACKEND (see server/routes/images/file.ts
 * and .../exists.ts), not by the browser. So it has to be a path that makes
 * sense on the machine hosting the Express server. On this user's setup those
 * are the same machine, but the import screen says so explicitly, because a
 * drive letter that is mapped on a workstation and not on the host is the one
 * way to get a folder full of paths that all read as "file is missing".
  */

 /*
 * WHERE THE PREFILLED VALUE COMES FROM
 *
 * *** NEVER HARDCODE A BASE FOLDER. *** A wrong base folder does not fail
 * loudly -- it stamps every imported row with a path that resolves to
 * nothing, and you find out ~1,700 rows later when every photo reports "file
 * is missing".
 *
 * The box is seeded from the SERVER: `GET /api/app-info` reports the folder
 * the app itself is installed in (see server/routes/app-info.ts). That is
 * almost certainly not where the photos live, and the import screen says so
 * plainly -- but it is a genuine path on the right machine, in the right
 * shape, with a drive letter the host really has. The user edits it down.
 *
 * The user's own choice is saved and WINS from then on; see
 * import-base-folder.ts, where the saved value takes priority over the
 * server's answer, always.
 *
 * There is deliberately no `DEFAULT_IMPORT_BASE_FOLDER` constant. It would be
 * named as though it were the default while holding only the last-resort
 * fallback, which is written as a plain `''` at the one place it is used.
  */

/**
 * A purely illustrative path, shown as placeholder text and in the hint on the
 * import screen. It is never used as a value — it exists so the user can see
 * the expected SHAPE of the answer (a drive letter and a folder on the host)
 * without it being mistaken for a working default.
 */
export const EXAMPLE_IMPORT_BASE_FOLDER = 'D:\\Coin Pictures';

/** The Windows path separator. Named so the joining rules read clearly. */
const SEPARATOR = '\\';

/**
 * Normalise one path fragment to Windows separators and trim the whitespace a
 * path pasted out of Explorer's address bar usually arrives with.
 */
function toWindowsSeparators(value: string): string {
  return value.trim().replace(/\//g, SEPARATOR);
}

/**
 * Strip trailing separators from the base folder.
 *
 * The user may well type `\\NAS\Coin Pictures\` (Explorer copies it
 * that way sometimes), and we add our own separator when joining, so leaving
 * theirs in place would produce a `...Pictures\\Business Strikes\...` with a
 * doubled slash in the middle. Windows tolerates that; SQL string comparisons
 * and the user reading the path do not.
 *
 * Note this only ever removes from the END, so the leading `\\` of a UNC path
 * is never touched. A base that is nothing BUT separators is left alone rather
 * than reduced to an empty string.
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
 * Join a user-supplied base folder to a browser-supplied relative path,
 * producing an absolute Windows path.
 *
 * The rules, in order:
 *
 *  1. Both halves are normalised to backslashes (`webkitRelativePath` always
 *     uses forward slashes) and trimmed.
 *  2. Trailing separators are stripped from the base, and leading ones from
 *     the relative half, so exactly ONE separator ends up between them.
 *  3. If the base's last folder name is the same as the relative path's first
 *     folder name, the duplicate is dropped — see the long note below.
 *  4. An empty base returns just the normalised relative path, and an empty
 *     relative path returns just the base. Neither is useful, but neither
 *     should produce a path with a stray separator on the end.
 *
 * RULE 3, THE DOUBLED FOLDER NAME — why it is worth the special case
 *
 * `webkitRelativePath` INCLUDES the name of the folder the user picked. So if
 * they point the picker at the share root `\\NAS\Coin Pictures`, every
 * file comes back as `Coin Pictures/<subfolder>/<file>.jpg`, and a naive join
 * with the prefilled base gives:
 *
 *     \\NAS\Coin Pictures\Coin Pictures\Business Strikes\x.jpg
 *                                  ^^^^^^^^^^^^^^ folder that does not exist
 *
 * ...which would mark all 1,700 imported images as "file missing". Since that
 * is precisely the default path through this screen, collapsing the repeat is
 * the right default.
 *
 * The trade-off is real but small: if a folder genuinely contains a subfolder
 * of the same name (`...\Pics\Pics\`), this drops a level that should have
 * stayed. That is why the import screen shows a LIVE EXAMPLE of the finished
 * path built from the first selected file — the user sees the actual result
 * before anything is written, and can adjust the base folder if it looks wrong.
 */
export function joinWindowsPath(baseFolder: string, relativePath: string): string {
  const base = stripTrailingSeparators(toWindowsSeparators(baseFolder ?? ''));
  const relative = toWindowsSeparators(relativePath ?? '').replace(/^[\\/]+/, '');

  if (base.length === 0) return relative;
  if (relative.length === 0) return base;

  const baseSegments = segmentsOf(base);
  const relativeSegments = segmentsOf(relative);

  // Rule 3: drop a repeated folder name at the seam. Case-insensitive because
  // Windows paths are.
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
 * The absolute path we will record for one picked file.
 *
 * `webkitRelativePath` is present for a directory pick and empty for a plain
 * multi-file pick, so `|| file.name` covers both without the caller caring
 * which kind of picker produced the File.
 *
 * Returns null when there is no base folder to anchor the name to. Null is a
 * completely normal value downstream — it is exactly what every image imported
 * before this feature existed has — and it means "no path recorded", which the
 * viewer renders as no link at all rather than a broken one.
 */
export function sourcePathForFile(baseFolder: string, file: File): string | null {
  // No base folder means no ABSOLUTE path is obtainable, and a bare relative
  // one is worse than nothing: the server resolves these paths against its own
  // working directory, so storing "a.jpg" would produce a link that either
  // 404s or, worse, opens some unrelated file. Record nothing instead.
  if (!baseFolder || baseFolder.trim().length === 0) return null;

  const relative = file.webkitRelativePath || file.name;
  const joined = joinWindowsPath(baseFolder, relative);
  return joined.length > 0 ? joined : null;
}

/* ---------------------------------------------------------------------------
 * COMPARING TWO STORED PATHS — "is this file already attached to that coin?"
 * ---------------------------------------------------------------------------
 * THE BUG THIS PREVENTS
 * Adding a handful of photos to a folder that has already been imported makes
 * an append-only attach try to import every image again: it has no way to
 * recognise a file it has already stored. So the comparison is on the
 * ORIGINAL file's absolute path -- the only thing that identifies a source
 * file -- against the paths the coin's existing images were recorded with
 * (CoinImages.SourcePath, fetched in bulk by
 * POST /api/coins/image-source-paths).
 *
 * WHY A COMPARISON NEEDS ITS OWN NORMAL FORM, AND WHY IT LIVES HERE
 * Two strings naming the same file routinely differ, because the two sides of
 * the comparison are produced by different code at different times:
 *
 *   - CASE. Windows paths are case-insensitive, and nothing enforces a casing
 *     anywhere in this app. The base-folder box holds whatever the user typed
 *     ("d:\coin pictures" one month, "D:\Coin Pictures" the next), and the
 *     filenames come off a camera that shouts (IMG_0042.JPG).
 *   - SEPARATORS. `webkitRelativePath` always uses forward slashes; everything
 *     joinWindowsPath() produces uses backslashes; and a path pasted out of
 *     Explorer can carry a trailing one.
 *   - STRAY REPEATS. A base folder typed with a trailing separator produces
 *     a doubled separator in the middle of the path, and rows written before
 *     stripTrailingSeparators() existed still hold exactly that.
 *
 * It lives in THIS file rather than next to the dedup logic because the rules
 * above are the same rules joinWindowsPath() already encodes — one set of
 * ideas about what a path is, in one place. A second set would drift, and the
 * cost of drift here is either duplicated photos or silently skipped ones.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * No filesystem resolution: no `..` collapsing, no short-name (8.3) expansion,
 * no symlink or junction following, no mapped-drive-to-UNC translation. Those
 * need the disk, and this runs in a browser. They are also not how these paths
 * are produced — both sides come from joinWindowsPath(), so they are already
 * in the same shape, and the normalisation here only has to absorb the drift
 * listed above. A miss simply means a photo is attached again, which is the
 * behaviour the user had before this feature; a false match would skip a photo
 * he wanted, which is worse. So when in doubt, this errs towards NOT matching.
 * ------------------------------------------------------------------------- */

/**
 * The form in which two source paths are compared.
 *
 * Returns `''` for null, undefined or blank — "no path recorded", which is
 * what every image imported before the SourcePath column existed has. Callers
 * must treat an empty normal form as "unknown" and never as a match, or two
 * path-less images would count as the same file.
 */
export function normalizeSourcePathForComparison(path: string | null | undefined): string {
  if (!path) return '';

  const windows = toWindowsSeparators(path);

  // A UNC path begins with exactly two separators and they are load-bearing:
  // \\NAS\pics\a.jpg and \NAS\pics\a.jpg are different locations. Hold the
  // prefix aside so the collapse below cannot eat it.
  const isUnc = windows.startsWith(SEPARATOR + SEPARATOR);
  const body = isUnc ? windows.slice(2) : windows;

  const collapsed = body
    .replace(/\\+/g, SEPARATOR)   // ...Pictures\\Business -> ...Pictures\Business
    .replace(/\\+$/, '');         // a trailing separator names the same folder

  const normalized = (isUnc ? SEPARATOR + SEPARATOR + collapsed : collapsed).toLowerCase();

  // A string that was nothing but whitespace and separators carries no
  // information; collapse it to the same "unknown" the null case produces.
  return normalized === SEPARATOR || normalized === SEPARATOR + SEPARATOR ? '' : normalized;
}

/**
 * Build the "this is what will be stored" example for the import screen.
 *
 * Showing a real, finished path for a real, selected file is the only way the
 * user can tell a correct base folder from a plausible-looking wrong one
 * BEFORE the import writes hundreds of rows.
 */
export function previewSourcePath(baseFolder: string, file: File | undefined): string | null {
  if (!file) return null;
  return sourcePathForFile(baseFolder, file);
}
