/*
 * Sibling inference: after every image in a batch is decided, place a photo
 * that could not identify a coin by itself on the strength of a sibling photo
 * that did. Besides match-decider.ts this is the only code that attaches, so
 * the reason string names the sibling that did the identifying.
 *
 * A sibling is a filename sharing the identifying text: the name minus the
 * words about the photograph (Obverse, Reverse, Label, Slab, ...) and the
 * shot number. Folders are never consulted, since one folder can hold many
 * unrelated coins. The quieter name's tokens must all appear in the louder one:
 *
 *     1884 3CN - PCGS PF65CAM - Obverse.jpg     -> 1884 3cn pcgs pf65cam
 *     1884 3CN - PCGS PF65CAM - Slab Label.jpg  -> 1884 3cn pcgs pf65cam
 *     1884 3CN - Obverse 2.jpg                  -> 1884 3cn  (sibling of both)
 *
 * Gates, in order:
 *   A. Not already matched.
 *   B. A real single-coin photo, not excluded from auto import; and more
 *      than a bare year ("1861 - Obverse.jpg" would match every 1861 file).
 *   C. All matched siblings point at one coin.
 *   D. Year agrees and coin type agrees (when both name one).
 *   E. No hard veto. A filename silent about the strike reads as 'business',
 *      so this also keeps unmarked shots off proof records.
 *   F. No rival: no other coin fits the filename equally well.
 *
 * Example: "1861 3CS - Obverse 2.jpg" with five 1861 3CS records (one proof,
 * four business strikes differing only by grade) is placed on nothing: the
 * proof fails E and the business strikes fail F.
 *
 * Only rows matched on their own may vouch for a sibling, so inference never
 * chains.
 */

import { ImageMatchResult } from '../../types/coin.model';
import { CoinSignature, Signature } from './coin-signature';
import { toSignature } from './filename-parser';
import { PHOTO_VARIANT_WORDS, SIDE_WORDS } from './filename-vocabulary';
import { diceSimilarity } from './match-scorer';
import { DISQUALIFIED_PHRASE, VetoVerdict, findVetoes } from './match-vetoes';
import { COIN_TYPE_STRONG_SIMILARITY } from './matching-thresholds';
import { denominationsAgree } from './reference-tables';
import { round } from './text-tokens';

/** Words that describe the photograph rather than the coin (from filename-vocabulary.ts). */
const PHOTO_WORDS: ReadonlySet<string> = new Set([
  ...SIDE_WORDS.map(entry => entry.word),
  ...PHOTO_VARIANT_WORDS
]);

/**
 * The identifying text of a filename: parser tokens minus photo words and
 * the shot number.
 *
 * The shot number comes from `parsed.take` (photo-markers.ts) rather than
 * dropping small numbers, because those are often face values:
 *     1904 $20 - Obverse.jpg              "20" is the face value
 *     1881-S Morgan - 20 - Obverse.jpg    "20" is the shot number
 */
export function identifyingTokens(tokens: readonly string[], take: number | null): Set<string> {
  const takeToken = take === null ? null : String(take);
  const identifying = new Set<string>();
  for (const token of tokens) {
    if (PHOTO_WORDS.has(token)) continue;
    if (takeToken !== null && token === takeToken) continue;
    identifying.add(token);
  }
  return identifying;
}

/**
 * True when every identifying word of `quiet` also appears in `loud`.
 * Containment, not equality, so a shot that omits the grade still qualifies.
 */
function sharesIdentifyingText(quiet: ReadonlySet<string>, loud: ReadonlySet<string>): boolean {
  for (const token of quiet) if (!loud.has(token)) return false;
  return true;
}

/**
 * Skip-line text for a vetoed inference. The proof case gets specific
 * wording because it is the most surprising outcome.
 */
function explainInferenceVeto(
  file: Signature,
  coin: Signature,
  coinLabel: string,
  verdict: VetoVerdict
): string {
  const lead = `Another photo of this name was attached to ${coinLabel}, but `;

  if (coin.strike === 'proof' && file.strike !== 'proof') {
    return lead +
      `that coin is a proof and this filename does not say Proof or PF, ` +
      `so it was not attached by inference.`;
  }

  return lead +
    `that coin is ${DISQUALIFIED_PHRASE}: ${verdict.reasons.join('; ')}, ` +
    `so it was not attached by inference.`;
}

/**
 * Gate F: does this coin fit the filename as well as the sibling's coin?
 * Deliberately generous (same year, compatible denomination and type, no
 * veto) so the stage stays cautious.
 */
function fitsEquallyWell(file: Signature, coin: Signature): boolean {
  if (file.year === null || coin.year === null) return false;
  const end = coin.yearRangeEnd ?? coin.year;
  if (file.year < coin.year || file.year > end) return false;

  // Silence on either side leaves the coin a rival.
  if (file.denomination && coin.denomination
      && !denominationsAgree(file.denomination, coin.denomination)) {
    return false;
  }

  if (file.coinTypeTokens.length > 0 && coin.coinTypeTokens.length > 0
      && diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens) < COIN_TYPE_STRONG_SIMILARITY) {
    return false;
  }

  if (findVetoes(file, coin).vetoed) return false;

  return true;
}

/**
 * Gate D: the year must be stated on both sides and match. The coin type
 * must agree only when both sides name one: types like "Three Cent Silver"
 * are fully consumed by the denomination and leave no coin-type tokens.
 */
function yearAndTypeAgree(file: Signature, coin: Signature): boolean {
  if (file.year === null || coin.year === null) return false;
  const end = coin.yearRangeEnd ?? coin.year;
  if (file.year < coin.year || file.year > end) return false;

  if (file.coinTypeTokens.length === 0 || coin.coinTypeTokens.length === 0) return true;
  return diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens) >= COIN_TYPE_STRONG_SIMILARITY;
}

/**
 * Place the photos a sibling can identify; leave everything else unchanged.
 * Pure, and preserves order (one result out per result in).
 *
 * @param results      every image in the batch, already decided and tiered.
 * @param coinSignatures the same precomputed inventory the decider used.
 */
export function inferFromSiblings(
  results: readonly ImageMatchResult[],
  coinSignatures: readonly CoinSignature[]
): ImageMatchResult[] {
  const byId = new Map(coinSignatures.map(entry => [entry.coin.id, entry]));

  // Only rows that cleared the auto gates themselves may vouch for a sibling.
  const identified = results
    .filter(result => result.tier === 'matched' && result.matchedRecordId)
    .map(result => ({
      result,
      coinId: result.matchedRecordId!,
      identifying: identifyingTokens(result.parsed.tokens, result.parsed.take ?? null)
    }));

  if (identified.length === 0) return [...results];

  return results.map(result => {
    // Gate A: only fill gaps.
    if (result.tier === 'matched') return result;
    // Gate B: excluded, non-coin and empty filenames are never inferred.
    if (result.parsed.excludedFromAutoImport) return result;
    if (result.parsed.isNonCoin || result.parsed.isEmpty) return result;

    const identifying = identifyingTokens(result.parsed.tokens, result.parsed.take ?? null);

    // Require a year plus at least one other identifying token.
    if (result.parsed.year === null || identifying.size < 2) return result;

    // Gate C: every sibling must point at the same coin.
    const siblingCoinIds = new Set(
      identified
        .filter(other => other.result !== result
          && sharesIdentifyingText(identifying, other.identifying))
        .map(other => other.coinId)
    );
    if (siblingCoinIds.size !== 1) return result;

    const coinId = [...siblingCoinIds][0];
    const entry = byId.get(coinId);
    if (!entry) return result;

    const file = toSignature(result.parsed);

    // Gate D: year and coin type agree.
    if (!yearAndTypeAgree(file, entry.signature)) return result;

    // Gate E: hard vetoes (including unmarked shot vs proof record); the
    // reason is added to the skip line.
    const verdict = findVetoes(file, entry.signature);
    if (verdict.vetoed) {
      return {
        ...result,
        skipReason: `${result.skipReason ?? ''} ${
          explainInferenceVeto(file, entry.signature, entry.label, verdict)
        }`.trim()
      };
    }

    // Gate F: no other coin fits this filename just as well.
    const rivals = coinSignatures.filter(
      other => other.coin.id !== coinId && fitsEquallyWell(file, other.signature)
    );
    if (rivals.length > 0) {
      return {
        ...result,
        skipReason:
          `${result.skipReason ?? ''} Another photo of this name was attached to ${entry.label}, ` +
          `but ${rivals.length} other coin${rivals.length === 1 ? '' : 's'} in your inventory ` +
          `fit${rivals.length === 1 ? 's' : ''} this filename just as well, so it was not ` +
          `attached by inference.`.trim()
      };
    }

    // Placed. `status` is 'auto' too, so tier 'matched' and the attached set
    // stay identical (asserted by the import-tier tests).
    const sibling = identified.find(other => other.coinId === coinId
      && sharesIdentifyingText(identifying, other.identifying))!;

    return {
      ...result,
      status: 'auto',
      matchedRecordId: coinId,
      confidence: round(result.confidence),
      reason:
        `Attached to ${entry.label} by inference from "${sibling.result.parsed.fileName}", ` +
        `which names the same coin and was matched on its own. The year and coin type agree, ` +
        `nothing conflicts, and no other coin in your inventory fits this filename.`,
      tier: 'matched',
      nearMatch: null,
      skipReason: null
    };
  });
}
