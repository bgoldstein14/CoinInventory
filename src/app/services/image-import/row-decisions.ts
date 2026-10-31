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

/* ===========================================================================
 * THE ONE ROW TIER 3 DOES NOT OFFER TO RESCUE
 * ---------------------------------------------------------------------------
 * Counterfeit photographs and multi-coin shots are held out of the AUTOMATED
 * import completely. The owner, on the group shots, and he said the same of
 * the fakes:
 *
 *   "Never automatically attach nor offer as attachable in the automated
 *    import. A user can try to manually choose such a photo manually at a
 *    later time to attach to a coin(s)."
 *   "Ignore the Fake coins."
 *
 * "Nor offer as attachable" is the part that lands here. Tier 3 is otherwise
 * read-only-plus-an-escape-hatch, and that escape hatch IS an offer, so these
 * rows must not have it. The modal hides the "Attach anyway..." link; the two
 * guards below are the same rule stated where it cannot be bypassed, so a
 * stale click or a future template change cannot attach one by accident.
 *
 * *** THIS DOES NOT MAKE THE FILE UNATTACHABLE, AND MUST NOT. ***
 *   "I never want a picture file to be off limits from choosing to attach to
 *    a coin even if the descriptor has nothing relevant to the coin itself."
 *   "Maybe it's an article about the coin or something like that that I'd
 *    want to attach."
 *
 * The row is still LISTED, with its reason, so nothing vanishes. And the
 * per-coin image gallery's add-images path — the manual route, which never
 * consults the matcher at all — attaches any file to any coin exactly as
 * before. The rule here is about what the IMPORT SCREEN offers, nothing more.
 * ========================================================================= */

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
 * TIER 2's one-click answer: "yes, that is the coin."
 *
 * The suggestion is `result.nearMatch.candidates[0]` — the best-ranked
 * candidate that passed the four-attribute near-match test. Note that it is
 * read from `nearMatch` and NOT from `result.matchedRecordId`, which is null
 * for a near match and stays null: the only thing that ever puts a coin on a
 * near-match row is this function, and it only runs when the user presses the
 * button.
 *
 * A row that is not a near match is left completely alone, so this cannot be
 * used to attach something from the read-only tier.
 */
export function acceptNearMatch(rows: readonly BatchImageRow[], fileName: string): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  const suggestion = row?.result.nearMatch;
  if (!row || row.result.tier !== 'near' || !suggestion) return [...rows];

  return chooseCandidate(rows, fileName, suggestion.candidates[0]);
}

/**
 * TIER 2's other answer: "no, it is this OTHER one" — the dropdown.
 *
 * `coinId` must be one of the near candidates on this row. Anything else is
 * ignored, which is what stops a stale or hand-crafted value from attaching a
 * photo to a coin the near-match test already rejected.
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

/* ===========================================================================
 * TIER 3's ESCAPE HATCH: "Attach anyway"
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL, WHEN TIER 3 IS SUPPOSED TO BE READ-ONLY
 *
 * The four-attribute near-match bar (year + coin type + denomination + grade,
 * all four present and all four agreeing) is STRICT ON PURPOSE, and nothing in
 * this file relaxes it. A census over the owner's real filenames showed what
 * that strictness costs: of 32 files in tier 3, 13 are genuine junk (group
 * shots, stamps, camera-default names) but 19 are real single-coin photos, and
 * only 2 of those 19 are genuinely WRONG matches. The other 17 failed because
 * a piece of information was ABSENT, not because anything contradicted. The
 * starkest case is
 *
 *     "1881 Morgan Dollar NGC 2599001.jpg"   ->  scores 97%
 *
 * which the matcher ranks first by a mile and which the bar refuses only
 * because the filename states no grade. Under a strictly button-less tier 3
 * that photo is UNREACHABLE: the right coin is sitting at the top of a ranked
 * list nobody can see.
 *
 * The owner was shown that trade-off and chose: keep the bar exactly where it
 * is, and give tier 3 a way back in. So the two functions below are the ONLY
 * way a tier-3 row can ever acquire a coin, and like every other decision in
 * this file they run only when the user presses something. The standing rule
 * is untouched:
 *
 *     "Silently filing an image under the wrong coin is much worse than
 *      asking."
 *
 * WHY A UI ESCAPE HATCH AND NOT A LOOSER MATCHER
 * Lowering the bar would move those 17 files into tier 2, where they would
 * each cost a question -- and it would drag the 2 genuinely wrong ones along
 * with them, dressed up as plausible suggestions. Leaving the bar alone and
 * adding an OPT-IN control keeps tier 3 at zero interaction for anyone who
 * ignores it, while making nothing truly unreachable.
 *
 * Note what a rescue does NOT touch: `result.tier` stays 'not-imported'. The
 * classification is the matcher's statement about the file and it is not the
 * user's to rewrite; keeping it also means the row holds its place in the
 * read-only list (and therefore in that list's paging) instead of jumping
 * sections under the cursor. It simply reads as a decision from then on, and
 * Undo is the ordinary `resetRow`, which sends a tier-3 row back to skipped.
 * ========================================================================= */

/**
 * Rescue a tier-3 row using one of the RANKED CANDIDATES the matcher already
 * produced.
 *
 * `result.candidates` is populated for every below-bar 'review' row that now
 * lands in tier 3, and often for 'none' rows too -- it is the same best-first
 * list the matcher built before the near-match test rejected it. Showing it
 * with its scores is what turns the 97% Morgan from a dead end into one click.
 *
 * Two guards, and they are the whole safety story of this function:
 *   1. the row must really be in tier 3, so this cannot be used as a back door
 *      around tier 2's own "only coins that passed the test" dropdown rule;
 *   2. `coinId` must be one of THIS row's candidates -- a stale or
 *      hand-crafted id attaches nothing at all.
 */
export function rescueWithCandidate(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string
): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  const candidate = row?.result.candidates.find(c => c.coinId === coinId);
  if (!row || row.result.tier !== 'not-imported' || !candidate) return [...rows];
  // Third guard: a counterfeit or multi-coin photo is not offered here at all.
  if (isExcludedFromAutoImport(row)) return [...rows];

  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: candidate.coinId,
    // The matcher's own score, kept as it is. The user has overridden the BAR,
    // not the arithmetic, and pretending the confidence is 1 would throw away
    // the most useful thing we know about this pairing.
    confidence: candidate.score,
    selected: true,
    selectionReason:
      `Attached anyway from the skipped list (${Math.round(candidate.score * 100)}% match): ${candidate.reason}`
  });
}

/**
 * Rescue a tier-3 row using a coin the user found with the FREE-TEXT SEARCH.
 *
 * For rows with no candidates at all -- an ancient with no year, a file the
 * parser could read nothing out of -- there is no ranked list to offer, so the
 * only honest option is to let the user name the coin himself. The search
 * behind it is `searchCoins` below, driven by the long-standing `CoinLookup`.
 *
 * Confidence is 1 here, which does not contradict the function above: the user
 * did not pick from a ranked list, he stated the answer outright, so the
 * matcher's opinion does not enter into it. Same convention as `assignCoin`.
 */
export function rescueWithCoin(
  rows: readonly BatchImageRow[],
  fileName: string,
  coinId: string,
  coinLabel: string
): BatchImageRow[] {
  const row = rows.find(r => r.fileName === fileName);
  // An empty coinId means "never mind". It must not clear anything here:
  // `resetRow` is the single undo path, so there is only one way back.
  if (!row || row.result.tier !== 'not-imported' || !coinId) return [...rows];
  // Same third guard as above: not offered in the automated import. The coin
  // itself is still perfectly attachable to this photo from its own gallery.
  if (isExcludedFromAutoImport(row)) return [...rows];

  return patch(rows, fileName, {
    decision: 'confirmed',
    selectedCoinId: coinId,
    confidence: 1,
    selected: true,
    selectionReason: `Attached anyway, manually assigned to ${coinLabel}.`
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
 * Undo a skip / choice: back to whatever the IMPORT TIER originally said.
 *
 * Note this keys off the tier and not off `status`. A tier-3 row was skipped
 * by the importer itself rather than by the user, so "undo" has to put it back
 * to skipped — sending it to 'review' would quietly add it to the queue the
 * whole redesign exists to empty.
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
