import { Injectable } from '@angular/core';
import {
  CoinRecord,
  ImageMatchResult,
  ParsedImageAttributes
} from '../types/coin.model';
import {
  buildCoinSignatures,
  describeCoin,
  type DenominationLabels
} from './image-matching/coin-signature';
import { parseFilename } from './image-matching/filename-parser';
import { matchOneImage } from './image-matching/match-decider';
import { inferFromSiblings } from './image-matching/sibling-inference';

 /**
  * Matches image filenames to coins in the inventory. Auto-assigns only when
  * nearly certain; anything less goes to review with a ranked shortlist.
  *
  * Stages (implemented as plain functions under ./image-matching/):
  * 1. Parse   filenames into typed attributes using exact token matching
  *            (filename-parser.ts; coin records via coin-signature.ts).
  *            "1881-S Morgan Dollar obverse.jpg" ->
  *            { year: 1881, mintMark: 's', denomination: 'dollar', coinTypeTokens: ['morgan'] }
  * 2. Score   each filename/coin pair 0..1; an attribute counts only when both
  *            sides have a value (match-scorer.ts).
  * 3. Decide  auto-assign only if the score is high, two independent strong
  *            attributes agree, and the runner-up is clearly behind; hard vetoes
  *            run first (match-decider.ts, match-vetoes.ts).
  * 4. Review tiers for near matches (near-match.ts).
  * 5. Sibling inference: attach other shots of an already-matched coin
  *    (sibling-inference.ts).
  * Tuning numbers live in matching-thresholds.ts.
  */

@Injectable({ providedIn: 'root' })
export class ImageMatchingService {
  /**
   * Matches a batch of image filenames against the inventory; one result per
   * input path, in order.
   *
   * @param denominationLabels optional id -> label snapshot of the denominations
   *   lookup, so linked coins are identified by their `DenominationId`. Without it
   *   coins are matched on their denomination text. The caller takes the snapshot
   *   once (see coin-signature.ts).
   */
  matchImages(
    imagePaths: string[],
    inventory: CoinRecord[],
    denominationLabels?: DenominationLabels | null
  ): ImageMatchResult[] {
    // Parse every coin once, not once per image.
    const coinSignatures = buildCoinSignatures(inventory, denominationLabels);

    const decided = imagePaths.map(path => matchOneImage(path, coinSignatures));

    // Stage 5 runs last over the finished results and only attaches rows that
    // were left unmatched, so it never loosens a gate. See sibling-inference.ts.
    return inferFromSiblings(decided, coinSignatures);
  }

  /** Parses one filename into typed attributes (exposed for the UI and tests). */
  parseFilename(imagePath: string): ParsedImageAttributes {
    return parseFilename(imagePath);
  }

  /** Display label for a coin, e.g. "Morgan Dollar 1881-S". */
  describeCoin(coin: CoinRecord): string {
    return describeCoin(coin);
  }
}
