 /*
 * photo-sets.ts
 *
 * Groups the files showing one coin (obverse, reverse, slab label, retakes,
 * Small/Orig renderings) so the review screen can ask once per coin:
 *
 *     1881 Morgan Dollar NGC 2599001 - Obverse.jpg
 *     1881 Morgan Dollar NGC 2599001 - Slab Label.jpg
 *     1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg
 *
 * Two files share a set when their identifying words (as defined in
 * sibling-inference.ts: tokens minus side, variant and shot number) are
 * equal, in any order. Equality, not containment: one answer applies to every
 * member, so a quiet name like "1884 3CN - Obverse 2" must not absorb every
 * 1884 3CN file.
 *
 * Never grouped: names with a single identifying word, and photos excluded
 * from the automated import. Decisions live in row-decisions.ts and the session.
  */

import { BatchImageRow, ParsedImageAttributes } from '../../types/coin.model';
import { PHOTO_VARIANT_WORDS, SIDE_WORDS } from '../image-matching/filename-vocabulary';
import { identifyingTokens } from '../image-matching/sibling-inference';
import { sideLabel, sideSortOrder } from './photo-variant';

/** One coin's worth of files, as the review screen shows it. */
export interface PhotoSet {
  /** The grouping key. Unique per set. */
  key: string;
  /** The first file in display order; the set's decisions are keyed by it. */
  leadFileName: string;
  /** The shared name with the photo words taken out, e.g. "1881 Morgan Dollar NGC 2599001". */
  descriptor: string;
  /** Members, obverse first, then reverse, label, the rest; then by take. */
  rows: BatchImageRow[];
}

/** Keys are a pure function of the parse, which never changes; parse once. */
const keyCache = new WeakMap<ParsedImageAttributes, string>();

/**
 * The set this file belongs to. Files with equal keys are one coin; a file
 * that must not be grouped gets a unique key.
 */
export function photoSetKey(row: Pick<BatchImageRow, 'fileName' | 'result'>): string {
  const parsed = row.result.parsed;
  const cached = keyCache.get(parsed);
  if (cached !== undefined) return cached;

  const identifying = identifyingTokens(parsed.tokens ?? [], parsed.take ?? null);
  const key =
    parsed.excludedFromAutoImport || identifying.size < 2
      ? `file:${row.fileName}`
      : `set:${[...identifying].sort().join(' ')}`;

  keyCache.set(parsed, key);
  return key;
}

/** Display order inside a set: the two shots that matter first. */
export function compareShots(a: BatchImageRow, b: BatchImageRow): number {
  return (
    sideSortOrder(a.photo.side) - sideSortOrder(b.photo.side) ||
    (a.photo.takeNumber ?? 0) - (b.photo.takeNumber ?? 0) ||
    a.fileName.localeCompare(b.fileName)
  );
}

/**
 * Collapse rows into photo sets, in the order each set first appears.
 */
export function groupPhotoSets(rows: readonly BatchImageRow[]): PhotoSet[] {
  const byKey = new Map<string, BatchImageRow[]>();
  for (const row of rows) {
    const key = photoSetKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  return [...byKey.entries()].map(([key, members]) => {
    const ordered = [...members].sort(compareShots);
    return {
      key,
      leadFileName: ordered[0].fileName,
      descriptor: setDescriptor(ordered[0]),
      rows: ordered
    };
  });
}

/**
 * What distinguishes one shot from the others in its set, for a chip:
 * "Obverse", "Reverse #2", "Label", "Obverse · Small", "Photo".
 */
export function shotLabel(row: BatchImageRow): string {
  const parts: string[] = [];
  if (row.photo.side !== 'unknown') parts.push(sideLabel(row.photo.side));
  if (row.photo.variant) parts.push(row.photo.variant);
  const take = row.photo.takeNumber !== null ? `#${row.photo.takeNumber}` : null;
  if (parts.length === 0) return take ? `Shot ${take}` : 'Photo';
  return take ? `${parts.join(' · ')} ${take}` : parts.join(' · ');
}

/** Words that describe the photograph, lower case. */
const PHOTO_WORDS: ReadonlySet<string> = new Set([
  ...SIDE_WORDS.map(entry => entry.word),
  ...PHOTO_VARIANT_WORDS
]);

/**
 * The shared name of a set, read off one member's filename: the extension
 * gone, and every " - " segment that only describes the photograph
 * ("Obverse", "Slab Label", "Small", "Reverse 2", "3") dropped.
 *
 *   "1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg" -> "1881 Morgan Dollar NGC 2599001"
 *   "1861 3CS - Obverse - FAKE.jpg"                  -> "1861 3CS - FAKE"
 *   "1874 $3 - NGC AU 58-2.jpg"                      -> "1874 $3 - NGC AU 58"
 */
export function setDescriptor(row: BatchImageRow): string {
  const stem = row.fileName.replace(/\.[a-z0-9]+$/i, '');
  const take = row.photo.takeNumber;

  const kept = stem
    .split(/\s+-\s+/)
    .filter(segment => {
      const words = segment.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return !words.every(word => PHOTO_WORDS.has(word) || (/^\d{1,2}$/.test(word) && Number(word) === take));
    });

  if (kept.length > 0 && take !== null) {
    // A take glued to the last segment: "NGC AU 58-2".
    kept[kept.length - 1] = kept[kept.length - 1].replace(new RegExp(`[-_\\s]+${take}$`), '');
  }

  const descriptor = kept.join(' - ').trim();
  return descriptor || stem;
}
