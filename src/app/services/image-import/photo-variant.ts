 /*
 * photo-variant.ts
 *
 * Works out from a filename which shot of a coin a file is:
 *   - face:     Obverse / Reverse / slab Label / unknown
 *   - variant:  "Small", "Orig", "Photo", "Sharpened"
 *   - take:     the trailing counter in "1874 $3 - NGC AU 58-2.jpg"
 *
 *   1880-S $1 - MS64 - Obverse - Photo.jpg
 *   1880-S $1 - MS64 - Obverse - Small.jpg      <- derivative
 *   1880-S $1 - MS64-2.jpg                      <- retake
 *   1870 1-cent NGC PF65RB - Label.jpg          <- slab label
 *
 * Rows start ticked, so this powers the review screen's bulk rules (keep only
 * Obverse + Reverse, drop retakes, drop labels).
 *
 * The matcher's own side/take/variant fields are preferred when present, but
 * they are optional, so they are probed by several possible names and
 * validated; anything unrecognised falls back to this file's regex read.
  */

import { ParsedImageAttributes, PhotoSide, PhotoVariantInfo } from '../../types/coin.model';

/**
 * Processing-variant words that follow the side in filenames. "Photo" is the
 * original camera shot, not a derivative; "Small", "Orig", "Sharpened" etc.
 * are alternate renderings, cleared by "deselect retakes".
 */
const VARIANT_WORDS: Record<string, { label: string; derivative: boolean }> = {
  small: { label: 'Small', derivative: true },
  large: { label: 'Large', derivative: true },
  orig: { label: 'Orig', derivative: true },
  original: { label: 'Orig', derivative: true },
  sharpened: { label: 'Sharpened', derivative: true },
  sharp: { label: 'Sharpened', derivative: true },
  cropped: { label: 'Cropped', derivative: true },
  crop: { label: 'Cropped', derivative: true },
  edited: { label: 'Edited', derivative: true },
  photo: { label: 'Photo', derivative: false },
  scan: { label: 'Scan', derivative: false }
};

/** Property names the matcher might use for the photo side. */
const SIDE_FIELD_CANDIDATES = ['photoSide', 'side', 'imageSide', 'coinSide', 'face'];

/** Property names the matcher might use for the take counter. */
const TAKE_FIELD_CANDIDATES = ['takeNumber', 'take', 'shotNumber', 'sequence', 'takeIndex'];

/** Property names the matcher might use for the processing variant. */
const VARIANT_FIELD_CANDIDATES = ['variant', 'photoVariant', 'rendering'];

/**
 * Containers the fields might be nested in (e.g. `parsed.photoMarkers.side`).
 * Flat fields are checked first.
 */
const NESTED_CONTAINERS = ['photo', 'markers', 'photoMarkers', 'photoInfo'];

/**
 * Normalise whatever the matcher gives us into our four-value PhotoSide.
 * Accepts 'Obverse', 'obverse', 'OBV', 'front', ... and rejects anything else.
 */
function coerceSide(value: unknown): PhotoSide | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'obverse' || text === 'obv' || text === 'front') return 'obverse';
  if (text === 'reverse' || text === 'rev' || text === 'back') return 'reverse';
  if (text === 'label' || text === 'slab' || text === 'holder') return 'label';
  if (text === 'unknown' || text === '' || text === 'none') return 'unknown';
  return null; // Unrecognised - ignore it and use our own read.
}

/** Accept a positive whole number; ignore anything else (null, NaN, "2nd", 0). */
function coerceTake(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

/**
 * Probe an optional field on the parsed attributes without depending on its
 * type. Bracket access is required by noPropertyAccessFromIndexSignature.
 */
function probe(parsed: ParsedImageAttributes | undefined, names: readonly string[]): unknown {
  if (!parsed) return undefined;
  const bag = parsed as unknown as Record<string, unknown>;

  // Flat first: parsed.side / parsed.take / ...
  for (const name of names) {
    const value = bag[name];
    if (value !== undefined && value !== null) return value;
  }

  // Then nested: parsed.photoMarkers.side / parsed.photo.take / ...
  for (const container of NESTED_CONTAINERS) {
    const nested = bag[container];
    if (!nested || typeof nested !== 'object') continue;
    const inner = nested as Record<string, unknown>;
    for (const name of names) {
      const value = inner[name];
      if (value !== undefined && value !== null) return value;
    }
  }

  return undefined;
}

/**
 * Read the side from the filename, matching whole words only (so "rev" in
 * "Revolt" doesn't count).
 */
function sideFromFileName(fileName: string): PhotoSide {
  const text = fileName.toLowerCase();
  // Explicit non-letter boundaries rather than \b.
  if (/(^|[^a-z])(obverse|obv)([^a-z]|$)/.test(text)) return 'obverse';
  if (/(^|[^a-z])(reverse|rev)([^a-z]|$)/.test(text)) return 'reverse';
  if (/(^|[^a-z])(label|slab)([^a-z]|$)/.test(text)) return 'label';
  return 'unknown';
}

/** Find a processing-variant word ("Small", "Orig", ...) in the filename. */
function variantFromFileName(fileName: string): { label: string; derivative: boolean } | null {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, '');
  // Split on " - ", "-", "_" and spaces and compare whole segments, so
  // "Photograph" isn't read as "Photo".
  const segments = withoutExtension.split(/\s*[-_]\s*|\s+/).map(s => s.trim().toLowerCase());
  for (let i = segments.length - 1; i >= 0; i--) {
    const hit = VARIANT_WORDS[segments[i]];
    // Only the last two segments count, so "1795 $5 Small Eagle" (a design
    // name) isn't read as a Small variant.
    if (hit && i >= segments.length - 2) return hit;
  }
  return null;
}

/**
 * Pull the trailing take counter out of a filename.
 *
 *   "1874 $3 - NGC AU 58-2.jpg"                -> 2
 *   "1849-O $1 ANACS XF45 - Reverse - 3-2.jpg" -> 2   (last counter wins)
 *   "1880-S $1 - MS64 - Obverse.jpg"           -> null
 *   "1906-S $5 - XF-AU.jpg"                    -> null
 *
 * The name must end with a separator and 1-2 digits: two digits so a year or
 * cert number is never a take, a separator so "MS63" is untouched.
 */
export function takeNumberFromFileName(fileName: string): number | null {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, '');
  const match = /[-_\s]+(\d{1,2})$/.exec(withoutExtension);
  if (!match) return null;
  const value = Number(match[1]);
  // "-0" is not a take; "-1" is the first take (not a retake).
  return value >= 1 ? value : null;
}

/**
 * Everything we know about which shot this file is.
 *
 * @param fileName - the bare filename, e.g. "1880-S $1 - Obverse - Small.jpg"
 * @param parsed   - the matcher's parse of the same name, when we have it.
 *                   Optional, and any extra fields on it are optional too.
 */
export function describePhoto(
  fileName: string,
  parsed?: ParsedImageAttributes
): PhotoVariantInfo {
  // 1. Side: prefer the matcher's value; its 'unknown' counts as no opinion.
  const matcherSide = coerceSide(probe(parsed, SIDE_FIELD_CANDIDATES));
  const side: PhotoSide =
    matcherSide && matcherSide !== 'unknown' ? matcherSide : sideFromFileName(fileName);

  // 2. Take number: same precedence.
  const matcherTake = coerceTake(probe(parsed, TAKE_FIELD_CANDIDATES));
  const takeNumber = matcherTake ?? takeNumberFromFileName(fileName);

  // 3. Variant: prefer the matcher's word, but take the label and derivative
  //    flag from our own table.
  const matcherVariant = probe(parsed, VARIANT_FIELD_CANDIDATES);
  const variant =
    (typeof matcherVariant === 'string'
      ? VARIANT_WORDS[matcherVariant.trim().toLowerCase()]
      : undefined) ?? variantFromFileName(fileName);

  return {
    side,
    variant: variant?.label ?? null,
    takeNumber,
    // A retake is take 2+ or a derivative rendering (Small / Orig / ...).
    isRetake: (takeNumber !== null && takeNumber >= 2) || (variant?.derivative ?? false)
  };
}

/** Sort key so a coin's photos read Obverse, Reverse, Label, then the rest. */
export function sideSortOrder(side: PhotoSide): number {
  switch (side) {
    case 'obverse': return 0;
    case 'reverse': return 1;
    case 'label': return 2;
    default: return 3;
  }
}

/** Title-case label for the UI, e.g. 'obverse' -> 'Obverse'. */
export function sideLabel(side: PhotoSide): string {
  switch (side) {
    case 'obverse': return 'Obverse';
    case 'reverse': return 'Reverse';
    case 'label': return 'Label';
    default: return 'Other';
  }
}
