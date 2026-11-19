/*
 * Hard vetoes: conflicts that make a coin not a match at all, rather than a
 * worse match. A score can be out-voted by other attributes; a veto cannot.
 * This is the single source of truth used by match-scorer.ts (reports the
 * verdict), match-decider.ts (drops vetoed coins before the gates) and
 * near-match.ts (uses the reasons as tier-2 blockers).
 *
 * A veto needs both sides to state something that contradicts. Silence is
 * not disagreement for year, denomination or coin type: a second photo of a
 * coin often says less than the first.
 *
 * Exceptions: the strike and counterfeit status. The proof/specimen and
 * fake designations are always written when true, so silence means
 * "business strike" / "genuine". proof-strike.ts resolves a silent strike to
 * 'business' before signatures are built. Do not extend this to other
 * attributes.
 *
 * Vetoes only ever make the matcher more cautious; the auto-assign gates
 * still all apply. The runner-up margin is measured over surviving coins
 * (see match-decider.ts).
 */

import { StrikeKind } from '../../types/coin.model';
import { Signature, formatYear } from './coin-signature';
import { strikeLabel } from './proof-strike';
import { denominationsAgree } from './reference-tables';

/*
 * Reason phrases that near-match.ts's skip reporting recognises, so a skipped
 * image can say why it was skipped. The decider-written phrases live here
 * rather than in match-decider.ts to avoid an import cycle with near-match.ts.
 */

/** Contained in every veto sentence. */
export const DISQUALIFIED_PHRASE = 'disqualified';

/**
 * Written by match-decider.ts when the filename does not say which coin it
 * means (no year, no denomination, or a generic "3-cent" with both 3CS and 3CN
 * in inventory).
 */
export const UNIDENTIFIED_PHRASE = 'The filename does not identify one coin';

/**
 * Written by match-decider.ts when it withholds an automatic attachment
 * because the photo is of the slab label. A label shot only rides along with
 * a coin photo (sibling-inference.ts); it never identifies a coin itself.
 */
export const LABEL_ONLY_PHRASE =
  'the photo is of the slab label rather than the coin, and a label alone never identifies a coin';

/** Why (and whether) one file/coin pair is disqualified outright. */
export interface VetoVerdict {
  /** True when this coin must not be matched, suggested or offered. */
  vetoed: boolean;
  /** One clause per conflict, to be joined with "; ". Empty when nothing conflicts. */
  reasons: string[];
}

const NO_VETO: VetoVerdict = { vetoed: false, reasons: [] };

/** Is this coin disqualified as the owner of this image? Pure and cheap. */
export function findVetoes(file: Signature, coin: Signature): VetoVerdict {
  const reasons: string[] = [];

  // Veto 1: year. A coin record may hold a range ("1916-1945" for a type set).
  if (file.year !== null && coin.year !== null) {
    const end = coin.yearRangeEnd ?? coin.year;
    if (file.year < coin.year || file.year > end) {
      reasons.push(`year ${file.year} does not match the record's ${formatYear(coin)}`);
    }
  }

  // Veto 2: denomination, via `denominationsAgree` so a generic "3¢" is not
  // vetoed against a 3CS record.
  if (file.denomination && coin.denomination) {
    if (!denominationsAgree(file.denomination, coin.denomination)) {
      reasons.push(
        `denomination ${file.denominationLabel ?? file.denomination} does not match ` +
        `${coin.denominationLabel ?? coin.denomination}`
      );
    }
  }

  /* Veto 3: different strikes (proof / business / specimen), in either
   * direction. A silent side has already been resolved to 'business'. Note
   * PL/DMPL/"prooflike" are business strikes, not proofs (proof-strike.ts). */
  if (isStrikeConflict(file.strike, coin.strike)) {
    reasons.push(
      `the filename describes ${strikeLabel(file.strike)} but the record is ` +
      `${strikeLabel(coin.strike)}, and those are never the same coin`
    );
  }

  /* Veto 4: fake against genuine. Otherwise identical descriptors
   * ("1861 3CS - XF45" vs "1861 3CS - XF45 - FAKE") need a veto to stay apart.
   * Silence means genuine, since fake/counterfeit/replica is always written. */
  if ((file.counterfeit ?? false) !== (coin.counterfeit ?? false)) {
    reasons.push(
      file.counterfeit
        ? 'the filename says this is a counterfeit but the record is a genuine coin'
        : 'the record is a counterfeit but the filename does not say fake or counterfeit'
    );
  }

  return reasons.length === 0 ? NO_VETO : { vetoed: true, reasons };
}

/**
 * Two stated strikes that differ. 'unknown' (the side had no text or grade at
 * all) never conflicts; any other difference does.
 */
function isStrikeConflict(left: StrikeKind, right: StrikeKind): boolean {
  if (left === 'unknown' || right === 'unknown') return false;
  return left !== right;
}

/**
 * The veto reasons as one sentence naming the coin, for the 'none' result and
 * the read-only skip list. Contains DISQUALIFIED_PHRASE by construction.
 */
export function describeVeto(coinLabel: string, verdict: VetoVerdict): string {
  return `${coinLabel} is ${DISQUALIFIED_PHRASE}: ${verdict.reasons.join('; ')}.`;
}
