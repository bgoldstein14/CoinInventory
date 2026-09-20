import { Injectable } from '@angular/core';
import {
  CoinRecord,
  ImageMatchResult,
  ParsedImageAttributes
} from '../types/coin.model';
import { buildCoinSignatures, describeCoin } from './image-matching/coin-signature';
import { parseFilename } from './image-matching/filename-parser';
import { matchOneImage } from './image-matching/match-decider';

/* ===========================================================================
 * ImageMatchingService
 * ---------------------------------------------------------------------------
 * Job: given a list of image FILENAMES and the coin inventory, decide which
 * image belongs to which coin -- but only claim a match when we are very
 * nearly certain. Anything less goes to the user with a ranked shortlist.
 *
 * The guiding rule (from the product owner):
 *   "Silently filing an image under the wrong coin is much worse than asking."
 *
 * So the matcher is deliberately pessimistic. It would rather send 20 images
 * to a one-click review queue than mis-attach one.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS (three stages)
 * ---------------------------------------------------------------------------
 * 1. PARSE   -- turn "1881-S Morgan Dollar obverse.jpg" into typed attributes:
 *               { year: 1881, mintMark: 's', denomination: 'dollar',
 *                 coinTypeTokens: ['morgan'] }
 *               Parsing works on DISCRETE TOKENS with exact word matching.
 *               It never regex-searches a joined string, because that is how
 *               the old version matched the "25" inside "1925" as a quarter.
 *
 * 2. SCORE   -- compare the filename's attributes to each coin's attributes,
 *               one attribute at a time, and produce a normalized 0..1 score.
 *               An attribute only participates if BOTH sides have a value.
 *               A missing value is never treated as agreement.
 *
 * 3. DECIDE  -- auto-assign only when all three safety gates pass:
 *               (a) high score, (b) at least two independent strong
 *               attributes agree, (c) the runner-up is clearly behind.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CODE LIVES
 * ---------------------------------------------------------------------------
 * This class is now a thin front door. The actual work lives in small,
 * single-purpose modules under `./image-matching/`, each with its own header
 * comment explaining what it owns:
 *
 *   matching-thresholds.ts -- every tuning number and why it has that value.
 *   reference-tables.ts    -- the coin dictionaries: denominations, mints,
 *                             stop words, camera prefixes, grading services.
 *   text-tokens.ts         -- shared token plumbing (tokenize, sequence
 *                             search, small string helpers).
 *   coin-signature.ts      -- stage 1 for coin RECORDS, plus the `Signature`
 *                             shape both sides are reduced to.
 *   filename-parser.ts     -- stage 1 for FILENAMES (the paranoid half).
 *   match-scorer.ts        -- stage 2, the 0..1 score for one pair.
 *   match-decider.ts       -- stage 3, the three safety gates.
 *
 * They export plain functions rather than classes, so this service stays
 * stateless and can still be built with a bare `new ImageMatchingService()`
 * (which is exactly what the spec file does).
 * =========================================================================== */

@Injectable({ providedIn: 'root' })
export class ImageMatchingService {
  /* =========================================================================
   * PUBLIC API
   * ======================================================================= */

  /**
   * Match a batch of image filenames against the inventory.
   *
   * Returns one result per input path, in the same order. The result type
   * extends the older `ImageMatchCandidate`, so any caller that only reads
   * `imagePath` / `matchedRecordId` / `confidence` / `reason` still works.
   */
  matchImages(imagePaths: string[], inventory: CoinRecord[]): ImageMatchResult[] {
    // Defect #8: parse every coin ONCE, not once per image. With 2,000 coins
    // and 500 images the old code did a million redundant parses.
    const coinSignatures = buildCoinSignatures(inventory);

    return imagePaths.map(path => matchOneImage(path, coinSignatures));
  }

  /**
   * Parse a single filename into typed attributes.
   * Exposed so the UI (and tests) can show exactly what we understood.
   */
  parseFilename(imagePath: string): ParsedImageAttributes {
    return parseFilename(imagePath);
  }

  /** Display label for a coin, e.g. "Morgan Dollar 1881-S". */
  describeCoin(coin: CoinRecord): string {
    return describeCoin(coin);
  }
}
