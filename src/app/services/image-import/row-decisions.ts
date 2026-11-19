 /*
 * Per-file decisions ("accept this suggestion", "use that candidate",
 * "skip it") as pure `rows -> rows` transforms.
 *
 * Invariant: a decision that gives a row a coin also ticks it, and one that
 * removes the coin unticks it.
  */

import { BatchImageRow, CoinRecord, RankedImageMatch } from '../../types/coin.model';
import { photoSetKey } from './photo-sets';

/*
 * Rows excluded from automated import (multi-coin shots) are not offered
 * "Attach anyway". The modal hides the link; the guards below enforce it. The
 * file stays listed and can still be attached by hand from the coin's gallery.
 */

/** True when the automated importer must not even offer this row a coin. */
function isExcludedFromAutoImport(row: BatchImageRow): boolean {
  return row.result.parsed.excludedFromAutoImport === true;
}

/** Replace one row, matched by filename. The array identity always changes. */
function patch(
  rows: readonly BatchImageRow[],
  fileName: string,
  updates: Partial<BatchImageRow>
): BatchImageRow[] {
  return rows.map(row => (row.fileName === fileName ? { ...row, ...updates } : row));
}

/** Accept the matcher's own pre-selected coin. */
export function confirmMatch(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  if (!row?.selectedCoinId) return [...rows];
  return patch(rows, fileName, { decision: 'confirmed', selected: true });
}

/** Throw away the matcher's suggestion and hand the decision back to the user. */
export function rejectMatch(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  return patch(rows, fileName, {
    decision: 'review',
    selectedCoinId: null,
    confidence: 0,
    selected: false,
    selectionReason: 'Suggestion rejected - choose a coin or skip this image.'
  });
}

/** Pick one of the matcher's ranked candidates. */
export function chooseCandidate(
  rows: readonly BatchImageRow[],
  fileName: string,
  candidate: RankedImageMatch
): BatchImageRow[] {
  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: candidate.coinId,
    confidence: candidate.score,
    selected: true,
    selectionReason: `Chosen from suggestions: ${candidate.reason}`
  });
}

/**
 * Tier 2's one-click answer: "yes, that is the coin." Uses
 * `result.nearMatch.candidates[0]` (`matchedRecordId` stays null for near
 * matches). Rows that aren't near matches are left alone.
 */
export function acceptNearMatch(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  const suggestion = row?.result.nearMatch;
  if (!row || row.result.tier !== 'near' || !suggestion) return [...rows];

  return chooseCandidate(rows, fileName, suggestion.candidates[0]);
}

/**
 * Tier 2's other answer: "no, it is this other one" (the dropdown). `coinId`
 * must be one of this row's near candidates; anything else is ignored.
 */
export function chooseNearCandidate(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string
): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  const candidate = row?.result.nearMatch?.candidates.find(c => c.coinId === coinId);
  if (!row || row.result.tier !== 'near' || !candidate) return [...rows];

  return chooseCandidate(rows, fileName, candidate);
}

/*
 * Tier 3 "Attach anyway".
 *
 * The near-match bar (year, coin type, denomination and grade all present and
 * agreeing) stays strict. Many tier-3 photos fail only because something is
 * missing, e.g. "1881 Morgan Dollar NGC 2599001.jpg" scores 97% but has no
 * grade. These two functions are the only way a tier-3 row gets a coin, and
 * only when the user asks.
 *
 * A rescue leaves `result.tier` as 'not-imported', so the row keeps its place
 * in the read-only list; Undo is the ordinary `resetRow`.
 */

/**
 * Rescue a tier-3 row using one of the matcher's ranked candidates.
 * Guards: the row must be tier 3 (not a back door around tier 2), and `coinId`
 * must be one of this row's candidates.
 */
export function rescueWithCandidate(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string
): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  const candidate = row?.result.candidates.find(c => c.coinId === coinId);
  if (!row || row.result.tier !== 'not-imported' || !candidate) return [...rows];
  // Excluded photos (e.g. multi-coin shots) are never offered.
  if (isExcludedFromAutoImport(row)) return [...rows];

  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: candidate.coinId,
    // Keep the matcher's score: the user overrode the bar, not the score.
    confidence: candidate.score,
    selected: true,
    selectionReason:
      `Attached anyway from the skipped list (${Math.round(candidate.score * 100)}% match): ${candidate.reason}`
  });
}

/**
 * Rescue a tier-3 row with a coin the user found via free-text search, for rows
 * with no candidates. Confidence is 1 because the user stated the answer, as
 * in `assignCoin`.
 */
export function rescueWithCoin(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string,
  coinLabel: string,
  reason = `Attached anyway, manually assigned to ${coinLabel}.`
): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  // An empty coinId means "never mind"; `resetRow` is the only undo path.
  if (!row || row.result.tier !== 'not-imported' || !coinId) return [...rows];
  if (isExcludedFromAutoImport(row)) return [...rows];

  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: coinId,
    confidence: 1,
    selected: true,
    selectionReason: reason
  });
}

/*
 * Photo sets: one decision for every shot of one coin (see photo-sets.ts).
 * Built only from the single-row decisions above, so all their guards still
 * apply per member.
 */

/**
 * "Attach anyway" for a whole tier-3 set. Each member uses the coin as one of
 * its own candidates when it can (keeping the score), otherwise as a manual
 * assignment (label shots often have no candidates).
 */
export function rescueSet(
  rows: readonly BatchImageRow[],
  fileNames: readonly string[],
  coinId: string,
  coinLabel: string
): BatchImageRow[] {
  let next = [...rows];
  for (const fileName of fileNames) {
    next = rescueWithCandidate(next, fileName, coinId);
    if (next.find(r => r.fileName === fileName)?.selectedCoinId !== coinId) {
      next = rescueWithCoin(next, fileName, coinId, coinLabel,
        `Attached anyway with the rest of its photo set, to ${coinLabel}.`);
    }
  }
  return next;
}

/**
 * Carry one photo's coin to the untouched members of its set, after the user
 * attached `sourceFileName`:
 *   - a waiting tier-2 member takes the coin if it is one of its near candidates;
 *   - a skipped tier-3 member is attached as "Attach anyway" would (e.g. the
 *     slab-label shot).
 * Already-decided rows and tier 1 are left alone.
 */
export function followPhotoSet(
  rows: readonly BatchImageRow[],
  sourceFileName: string,
  coinLabel: string
): BatchImageRow[] {
  const source = rows.find(r => r.fileName === sourceFileName);
  const coinId = source?.selectedCoinId;
  if (!source || !coinId) return [...rows];

  const key = photoSetKey(source);
  let next = [...rows];
  for (const row of rows) {
    if (row.fileName === sourceFileName || photoSetKey(row) !== key) continue;
    if (row.result.tier === 'near' && row.decision === 'review') {
      next = chooseNearCandidate(next, row.fileName, coinId);
    } else if (row.result.tier === 'not-imported' && row.decision === 'skipped' && !row.selectedCoinId) {
      next = rescueWithCoin(next, row.fileName, coinId, coinLabel,
        `Same photo set as "${sourceFileName}", which you attached to ${coinLabel}.`);
    }
  }
  return next;
}

/**
 * Assign to any coin in the inventory (from the search box).
 * An empty coinId means "clear the assignment".
 */
export function assignCoin(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string,
  coinLabel: string
): BatchImageRow[] {
  if (!coinId) {
    return patch(rows, fileName, {
      decision: 'review',
      selectedCoinId: null,
      confidence: 0,
      selected: false
    });
  }
  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: coinId,
    // Assigned by hand, so confidence is 1.
    confidence: 1,
    selected: true,
    selectionReason: `Manually assigned to ${coinLabel}.`
  });
}

/** "Leave this photo alone." */
export function skipRow(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  return patch(rows, fileName, {
    decision: 'skipped',
    selectedCoinId: null,
    confidence: 0,
    selected: false,
    selectionReason: 'Skipped - this image will not be attached.'
  });
}

/**
 * Undo a skip or choice: back to what the import tier originally said. Keys off
 * the tier, so a tier-3 row goes back to skipped rather than into the review queue.
 */
export function resetRow(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  if (!row) return [...rows];

  const wasMatched = row.result.tier === 'matched' && !!row.result.matchedRecordId;
  if (wasMatched) {
    return patch(rows, fileName, {
      decision: 'auto',
      selectedCoinId: row.result.matchedRecordId,
      confidence: row.result.confidence,
      selected: true,
      selectionReason: row.result.reason
    });
  }

  const autoSkipped = row.result.tier === 'not-imported';
  return patch(rows, fileName, {
    decision: autoSkipped ? 'skipped' : 'review',
    selectedCoinId: null,
    confidence: 0,
    selected: false,
    selectionReason: autoSkipped
      ? (row.result.skipReason ?? row.result.reason)
      : row.result.reason
  });
}

/**
 * Free-text coin search. Every typed word must appear in the coin's label, in
 * any order. Capped at 8 results since it runs on every keystroke.
 */
export function searchCoins(
  inventory: readonly CoinRecord[],
  term: string,
  labelFor: (coin: CoinRecord) => string
): CoinRecord[] {
  const cleaned = term.trim().toLowerCase();
  // Below two characters every coin matches, which is noise, not help.
  if (cleaned.length < 2) return [];
  const words = cleaned.split(/\s+/);

  const hits: CoinRecord[] = [];
  for (const coin of inventory) {
    const label = labelFor(coin).toLowerCase();
    if (words.every(word => label.includes(word))) hits.push(coin);
    if (hits.length === 8) break;
  }
  return hits;
}

/**
 * What was parsed from the filename, as chips the user can sanity-check (a
 * year misread from a cert number is obvious at a glance). Empty when nothing
 * usable was found.
 */
export function parsedChips(row: BatchImageRow): string[] {
  const parsed = row.result.parsed;
  const chips: string[] = [];
  if (parsed.year !== null) chips.push(`Year ${parsed.year}`);
  if (parsed.mintMark) chips.push(`Mint ${parsed.mintMark.toUpperCase()}`);
  if (parsed.denominationLabel) chips.push(parsed.denominationLabel);
  if (parsed.coinTypeTokens.length) chips.push(`Type: ${parsed.coinTypeTokens.join(' ')}`);
  if (parsed.grade) chips.push(`Grade ${parsed.grade.toUpperCase()}`);
  for (const cert of parsed.certNumbers) chips.push(`Cert ${cert}`);
  return chips;
}
