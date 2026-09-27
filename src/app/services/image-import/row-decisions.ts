/* ===========================================================================
 * row-decisions.ts
 * ---------------------------------------------------------------------------
 * The per-file decisions ("accept this suggestion", "use that candidate",
 * "skip it") as pure `rows -> rows` transforms.
 *
 * Same reasoning as selection-rules.ts: the modal component should read as a
 * list of one-line signal updates, and the rules about what a decision does to
 * the tick-box and the confidence should be testable on their own.
 *
 * INVARIANT worth stating once: whenever a decision gives a row a coin, that
 * row also becomes ticked, and whenever a decision takes the coin away the
 * row becomes unticked. "Selected" can never mean "will be written to nowhere".
 * =========================================================================== */

import { BatchImageRow, CoinRecord, RankedImageMatch } from '../../types/coin.model';

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
    // The user said so by hand, so confidence is by definition 1.
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
 * Undo a skip / choice: back to whatever the matcher originally said.
 * A row the matcher was confident about returns to ticked; anything else
 * returns to "waiting on the user" and stays unticked.
 */
export function resetRow(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  if (!row) return [...rows];

  const wasAuto = row.result.status === 'auto' && !!row.result.matchedRecordId;
  return patch(rows, fileName, {
    decision: wasAuto ? 'auto' : 'review',
    selectedCoinId: wasAuto ? row.result.matchedRecordId : null,
    confidence: wasAuto ? row.result.confidence : 0,
    selected: wasAuto,
    selectionReason: row.result.reason
  });
}

/**
 * Free-text coin search for the "none of these is right" case.
 *
 * Every word typed must appear somewhere in the coin's label, which makes
 * "morgan 1881" work regardless of the order the words are in. Capped at 8
 * results because it renders inside a card and runs on every keystroke over
 * the whole inventory.
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
 * "What we read from the file name", as chips the user can sanity-check.
 *
 * Showing the parse back is the cheapest safety net in the whole feature: if
 * the matcher read "Year 1925" out of a cert number, the wrong chip is obvious
 * at a glance, whereas a wrong match buried in a list of 200 coins is not.
 * An empty list means the file name told us nothing usable.
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
