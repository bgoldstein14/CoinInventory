/* ===========================================================================
 * photo-variant.ts
 * ---------------------------------------------------------------------------
 * Works out, from a filename alone, WHICH SHOT of a coin a file is:
 *   - which face:      Obverse / Reverse / slab Label / unknown
 *   - which variant:   "Small", "Orig", "Photo", "Sharpened"
 *   - which take:      the trailing counter in "1874 $3 - NGC AU 58-2.jpg"
 *
 * Why the review screen needs this
 * --------------------------------
 * A single coin routinely has 8-10 files on the share:
 *
 *   1880-S $1 - MS64 - Obverse - Photo.jpg
 *   1880-S $1 - MS64 - Reverse - Photo.jpg
 *   1880-S $1 - MS64 - Obverse - Small.jpg      <- derivative
 *   1880-S $1 - MS64 - Obverse - Orig.jpg       <- derivative
 *   1880-S $1 - MS64-2.jpg                      <- retake
 *   1870 1-cent NGC PF65RB - Label.jpg          <- slab label, not the coin
 *
 * Everything starts ticked (the user asked for that), so without side/variant
 * knowledge "untick the ones I don't want" means 8 individual clicks per coin
 * times ~200 coins. With it we can offer one-click bulk rules: keep only
 * Obverse + Reverse, drop retakes, drop Label shots.
 *
 * ---------------------------------------------------------------------------
 * DEFENSIVE READ OF THE MATCHER'S OWN FIELDS
 * ---------------------------------------------------------------------------
 * The matcher is being upgraded in parallel to expose the side and the take
 * itself. When those fields land we want to use them (the matcher sees more
 * context than we do), but this code must compile and behave correctly TODAY,
 * before they exist.
 *
 * So we never reference the new fields by a hard-typed property. We take the
 * parsed object as an index-signature bag, probe a handful of plausible names,
 * accept the value only if it is a shape we understand, and otherwise fall
 * back to our own regex read of the filename. No field name we guess wrong
 * about can break anything - it just falls through to the fallback.
 * =========================================================================== */

import { ParsedImageAttributes, PhotoSide, PhotoVariantInfo } from '../../types/coin.model';

/**
 * Processing-variant words that appear after the side in the share's naming
 * convention. Order matters only for display; all are treated the same way.
 *
 * "Photo" is the ORIGINAL full-size camera shot, so it is NOT a derivative.
 * "Small", "Orig" and "Sharpened" are alternate renderings of a shot we
 * already have, which is what "deselect retakes" is meant to clear out.
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

/** Property names the upgraded matcher might use for the photo side. */
const SIDE_FIELD_CANDIDATES = ['photoSide', 'side', 'imageSide', 'coinSide', 'face'];

/** Property names the upgraded matcher might use for the take counter. */
const TAKE_FIELD_CANDIDATES = ['takeNumber', 'take', 'shotNumber', 'sequence', 'takeIndex'];

/** Property names the upgraded matcher might use for the processing variant. */
const VARIANT_FIELD_CANDIDATES = ['variant', 'photoVariant', 'rendering'];

/**
 * Containers the new fields might be nested inside instead of sitting flat on
 * the parsed object, e.g. `parsed.photoMarkers.side` rather than `parsed.side`.
 * We look flat first, then inside each of these.
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
 * Probe an optional field on the parsed attributes without depending on it
 * existing in the type. `parsed as unknown as Record<string, unknown>` is the
 * whole trick: it turns a typed object into a bag we can safely ask questions
 * of. Bracket access is required because tsconfig sets
 * noPropertyAccessFromIndexSignature.
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
 * Read the side straight out of the filename.
 *
 * Word-boundary matching only. A substring search would classify
 * "Reverse Proof" fine but would also see "obverse" inside made-up words and,
 * worse, would match the "rev" in "Revolt" ("67-68 CE 1st Revolt - Obverse").
 */
function sideFromFileName(fileName: string): PhotoSide {
  const text = fileName.toLowerCase();
  // \b would not fire against "obverse-2" on some engines, so we bracket with
  // an explicit "start, or a non-letter" on each side.
  if (/(^|[^a-z])(obverse|obv)([^a-z]|$)/.test(text)) return 'obverse';
  if (/(^|[^a-z])(reverse|rev)([^a-z]|$)/.test(text)) return 'reverse';
  if (/(^|[^a-z])(label|slab)([^a-z]|$)/.test(text)) return 'label';
  return 'unknown';
}

/** Find a processing-variant word ("Small", "Orig", ...) in the filename. */
function variantFromFileName(fileName: string): { label: string; derivative: boolean } | null {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, '');
  // The share separates parts with " - ", but also plain "-" and "_", so we
  // split on all of them and look at whole segments. Matching whole segments
  // (not substrings) stops "Photograph" or a coin named "Small Eagle" from
  // being read as the "- Small" derivative marker... which is a real design:
  // "1795 $5 Small Eagle". Hence: only a trailing-ish standalone segment counts.
  const segments = withoutExtension.split(/\s*[-_]\s*|\s+/).map(s => s.trim().toLowerCase());
  for (let i = segments.length - 1; i >= 0; i--) {
    const hit = VARIANT_WORDS[segments[i]];
    // Only the last two segments are treated as variant markers. "Small Eagle"
    // puts "small" in the middle of the name, where it is part of the coin
    // type, not a file variant.
    if (hit && i >= segments.length - 2) return hit;
  }
  return null;
}

/**
 * Pull the trailing take counter out of a filename.
 *
 * Real examples and what we want:
 *   "1874 $3 - NGC AU 58-2.jpg"                -> 2   (second shot)
 *   "2008 Hawaii Quarter - Dropped D - 2.JPG"  -> 2
 *   "1849-O $1 ANACS XF45 - Reverse - 3-2.jpg" -> 2   (last counter wins)
 *   "1880-S $1 - MS64 - Obverse.jpg"           -> null
 *   "1906-S $5 - XF-AU.jpg"                    -> null (AU is not a counter)
 *
 * The rule: the name must END with a separator followed by 1-2 digits. We cap
 * the digits at two so a trailing year ("1881") or a cert number is never
 * mistaken for a take, and we require a separator so "MS63" is untouched.
 */
export function takeNumberFromFileName(fileName: string): number | null {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, '');
  const match = /[-_\s]+(\d{1,2})$/.exec(withoutExtension);
  if (!match) return null;
  const value = Number(match[1]);
  // "-0" is not a take. "-1" is the first take, which we keep but do not
  // consider a retake (see isRetake below).
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
  // 1. Side: prefer the matcher's opinion, fall back to our own regex.
  //    A matcher value of 'unknown' is treated as "no opinion" so our own
  //    read still gets a chance.
  const matcherSide = coerceSide(probe(parsed, SIDE_FIELD_CANDIDATES));
  const side: PhotoSide =
    matcherSide && matcherSide !== 'unknown' ? matcherSide : sideFromFileName(fileName);

  // 2. Take number: same precedence.
  const matcherTake = coerceTake(probe(parsed, TAKE_FIELD_CANDIDATES));
  const takeNumber = matcherTake ?? takeNumberFromFileName(fileName);

  // 3. Variant: prefer the matcher's word, but look the label and the
  //    "is this a derivative?" flag up in our own table so the bulk rules
  //    behave identically either way.
  const matcherVariant = probe(parsed, VARIANT_FIELD_CANDIDATES);
  const variant =
    (typeof matcherVariant === 'string'
      ? VARIANT_WORDS[matcherVariant.trim().toLowerCase()]
      : undefined) ?? variantFromFileName(fileName);

  return {
    side,
    variant: variant?.label ?? null,
    takeNumber,
    // A retake is "not the first/only shot": take 2 or higher, or a derivative
    // rendering (Small / Orig / Sharpened) of a shot we already have.
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
