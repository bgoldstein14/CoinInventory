/* ===========================================================================
 * sibling-inference.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 5, and the only stage that looks at MORE THAN ONE IMAGE AT A TIME:
 *   placing a photograph that could not identify a coin by itself, on the
 *   strength of a SIBLING photograph that already did.
 *
 *   One public entry point, `inferFromSiblings`, called once per batch by
 *   ImageMatchingService.matchImages after every image has been decided.
 *
 * ---------------------------------------------------------------------------
 * THE OWNER'S WORDS, AND HOW NARROW THEY ARE
 * ---------------------------------------------------------------------------
 *   He opened with the want:
 *
 *       "if I match it with an image, all related image files of similar
 *        names (including for both obverse/reverse/slab designations) should
 *        automatically be attached at that point"
 *
 *   and when asked exactly when that inference is allowed, he answered:
 *
 *       "It should infer a match if the year and type match but not if the
 *        inventory item is described as a proof and the pictures don't
 *        contain that descriptor Proof/PF. Proofs are always described as
 *        such in the inventory as well as the pictures."
 *
 *   READ THAT SECOND SENTENCE CAREFULLY, BECAUSE IT IS NARROWER THAN THE
 *   QUESTION IT ANSWERS. It gives TWO conditions, not one:
 *
 *     1. the year and the coin type must agree, and
 *     2. THE PROOF EXCLUSION -- if the inventory coin is a proof and the
 *        filename does not say Proof/PF, that coin is OUT. He justifies it
 *        himself: proofs are always written on both sides, so a filename
 *        that is silent about the strike is not silent by accident. It is
 *        saying this is not the proof.
 *
 *   Everything else about his sentence is permissive, and this file is
 *   therefore deliberately stingier than it has to be, under his standing
 *   tie-breaker: "I can always force an image to be associated with a coin
 *   manually, but the automated process should be very descriminatory."
 *
 * ---------------------------------------------------------------------------
 * !! THE PROOF EXCLUSION IS NO LONGER IMPLEMENTED HERE -- READ THIS !!
 * ---------------------------------------------------------------------------
 *   Condition 2 above used to be a gate of its own in this file, a function
 *   called `proofExcluded`. IT HAS BEEN DELETED, and nothing was given up by
 *   deleting it. The rule is still enforced, by the ordinary hard vetoes.
 *
 *   What changed is that the owner generalised his own sentence:
 *
 *     "The Proof descriptor should always be part of the image file name as
 *      well as part of the inventory description otherwise it's assumed the
 *      coin is a business strike."
 *
 *   proof-strike.ts now resolves a filename that says nothing about the
 *   strike to 'business' rather than 'unknown', so a quiet filename against
 *   a proof record is a STATED disagreement and match-vetoes.ts disqualifies
 *   the pair outright -- at gate E below, one step before the old gate F
 *   would have run. The old gate was dead code the moment that landed:
 *
 *     coin is a proof + file says proof     -> no veto, no exclusion. Allowed.
 *     coin is a proof + file says nothing   -> file is now 'business', VETOED
 *                                              at gate E. Never reaches F.
 *     coin is a proof + file says SP        -> VETOED at gate E as before.
 *     file strike 'unknown'                 -> only possible for an EMPTY
 *                                              filename, which gate B has
 *                                              already thrown out.
 *
 *   TWO MECHANISMS FOR ONE RULE IS A BUG WAITING TO HAPPEN -- the whole
 *   argument in the header of match-vetoes.ts for having a single source of
 *   truth applies here too -- so there is now one. What this file kept is the
 *   EXPLANATION: gate E still writes his wording into the skip line, because
 *   "this filename does not say Proof or PF" is what he needs to read, and
 *   it is more useful than the bare veto sentence.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SIBLING IS -- THE DEFINITION, EXPLICITLY
 * ---------------------------------------------------------------------------
 *   A SIBLING IS A FILENAME THAT SHARES THE IDENTIFYING TEXT. IT IS NOT A
 *   FILE IN THE SAME FOLDER, AND THE FOLDER IS NEVER CONSULTED.
 *
 *   That distinction is the whole safety of this stage. The share has
 *   directories like "Early Proofs" holding sixty unrelated coins; if being
 *   filed together were enough, one correct match would drag fifty-nine
 *   wrong ones behind it. (filename-parser.ts already refuses to look at
 *   directories for the same reason -- `baseName` throws every path
 *   component away so that a folder called "Early Proofs" cannot make its
 *   contents look like proofs.)
 *
 *   "The identifying text" means: the filename, extension removed, with the
 *   words that describe the PHOTOGRAPH rather than the coin taken out --
 *   Obverse, Reverse, Label, Slab, Photo, Small, Sharpened, and the shot
 *   number that follows them. What is left is the year, the denomination,
 *   the grading service, the grade, the variety: everything that says WHICH
 *   COIN.
 *
 *       1884 3CN - PCGS PF65CAM - Obverse.jpg     -> 1884 3cn pcgs pf65cam
 *       1884 3CN - PCGS PF65CAM - Slab Label.jpg  -> 1884 3cn pcgs pf65cam
 *       1884 3CN - Obverse 2.jpg                  -> 1884 3cn
 *
 *   Two files are siblings when the quieter one's identifying words are ALL
 *   present in the louder one's. The first two above are siblings because
 *   they are identical; the third is a sibling of either because "1884 3cn"
 *   is contained in "1884 3cn pcgs pf65cam". Containment rather than
 *   equality is what lets a photo that merely omits the grade be recognised
 *   as another shot of the same coin -- and it is safe only because of the
 *   gates below, which do not care how the candidate was found.
 *
 *   A file whose identifying text is a YEAR AND NOTHING ELSE is refused
 *   outright. "1861 - Obverse.jpg" is contained in every 1861 filename there
 *   is, and that is not a family resemblance, it is an empty one.
 *
 * ---------------------------------------------------------------------------
 * THE GATES, IN ORDER, AND WHAT EACH ONE IS FOR
 * ---------------------------------------------------------------------------
 *   A. The file was NOT already placed. This stage only ever fills a gap.
 *   B. It is a real single-coin photo (not a stamp, not IMG_0042.JPG).
 *   C. Its siblings all point at ONE coin. Two matched siblings naming two
 *      different coins means the shared text was not identifying after all.
 *   D. The year agrees and the coin type agrees -- his first condition.
 *   E. Nothing is vetoed: no year conflict, no denomination conflict, no
 *      stated strike conflict. The ordinary rules still apply -- AND, since
 *      a silent filename now states "business strike", this gate is also
 *      where his second condition (the proof exclusion) is enforced. There
 *      used to be a separate gate F for it; see the note above.
 *   F. NO RIVAL. No other coin in the inventory fits this filename just as
 *      well. This gate is not in his sentence; it is the tie-breaker applied
 *      to it, and it is what makes his own worked example come out right
 *      (below).
 *
 * ---------------------------------------------------------------------------
 * HIS WORKED EXAMPLE, WHICH THIS FILE MUST REPRODUCE
 * ---------------------------------------------------------------------------
 *       1861 3CS - Obverse 2.jpg
 *
 *   carries no grade. He owns FIVE 1861 Three Cent Silver records: one
 *   PCGS PF64 proof, plus an AU, an EF and two XFs. What has to happen:
 *
 *     - the proof is EXCLUDED, because the filename says nothing about
 *       proof -- which now means it positively says "business strike", so
 *       the ordinary strike veto throws the pair out (gate E);
 *     - the four business strikes differ from each other only by grade, so
 *       even if one of them were reached there would be no way to choose
 *       between them (gate F);
 *     - therefore the file is PLACED ON NOTHING and stays in the listed
 *       skip report.
 *
 *   Both gates independently produce that answer, which is the point of
 *   having both: the sibling rule must not be able to bulldoze a genuinely
 *   ambiguous case just because one shot of it happened to be matched.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE STAGE AND NOT PART OF match-decider.ts
 * ---------------------------------------------------------------------------
 *   match-decider.ts decides ONE image against the inventory and knows
 *   nothing about any other image; that independence is what makes it
 *   testable and what makes its three gates easy to reason about. Sibling
 *   inference is the opposite shape -- it is a fact about the BATCH -- so it
 *   runs afterwards, over the finished results, and can only ever turn a
 *   row that was left alone into a row that is attached. It cannot loosen a
 *   gate, because it never runs a gate; it re-asks a different question.
 *
 *   It DOES attach, which makes it the second of only two files allowed to
 *   (the other is match-decider.ts). That is why every gate above is spelled
 *   out and why the reason string names the sibling that did the
 *   identifying -- so a wrong placement can be traced to the photograph
 *   that caused it in one glance.
 * =========================================================================== */

import { ImageMatchResult } from '../../types/coin.model';
import { CoinSignature, Signature } from './coin-signature';
import { toSignature } from './filename-parser';
import { PHOTO_VARIANT_WORDS, SIDE_WORDS } from './filename-vocabulary';
import { diceSimilarity } from './match-scorer';
import { DISQUALIFIED_PHRASE, VetoVerdict, findVetoes } from './match-vetoes';
import { COIN_TYPE_STRONG_SIMILARITY } from './matching-thresholds';
import { denominationsAgree } from './reference-tables';
import { round } from './text-tokens';

/**
 * Words that describe the PHOTOGRAPH rather than the coin.
 *
 * Reused wholesale from filename-vocabulary.ts rather than re-listed, so
 * that a side word or a variant word added for the parser is automatically
 * ignored here too. Nothing drifts.
 */
const PHOTO_WORDS: ReadonlySet<string> = new Set([
  ...SIDE_WORDS.map(entry => entry.word),
  ...PHOTO_VARIANT_WORDS
]);

/**
 * THE IDENTIFYING TEXT of a filename, as a set of tokens.
 *
 * Everything the parser tokenized, minus the words about the photograph and
 * minus the shot number. See the header for why this, and not the folder, is
 * what makes two files siblings.
 *
 * THE SHOT NUMBER IS TAKEN FROM `parsed.take`, NOT GUESSED AT. The obvious
 * shortcut -- "drop any one- or two-digit token" -- is wrong in this
 * collection, and wrong in a way that quietly switches the whole stage off:
 *
 *     1904 $20 - Obverse.jpg       the "20" is the FACE VALUE
 *     1913 50-Cent Canadian ...    the "50" is the FACE VALUE
 *     1881-S Morgan - 20 - Obverse.jpg   THIS "20" is the shot number
 *
 * Throwing the first two away leaves "1904" as the entire identifying text,
 * which is then refused for being a bare year and the photo is never placed.
 * photo-markers.ts has already worked out which number is the take, using
 * rules ("a number glued to the side word", "a segment that is ONLY a
 * number") that know the difference. Reading its answer is both correct and
 * one less place for the two to disagree.
 */
function identifyingTokens(tokens: readonly string[], take: number | null): Set<string> {
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
 * Is `quiet` another photograph of whatever `loud` shows?
 *
 * True when every identifying word of the quiet filename also appears in the
 * loud one. Containment, not equality: the quiet one is typically the shot
 * that omits the grade, and refusing it would make this whole stage fire
 * only on files that were already spelled identically.
 */
function sharesIdentifyingText(quiet: ReadonlySet<string>, loud: ReadonlySet<string>): boolean {
  for (const token of quiet) if (!loud.has(token)) return false;
  return true;
}

/**
 * WHY A VETO STOPPED THIS INFERENCE, in words he will recognise.
 *
 * MESSAGE ONLY -- IT DECIDES NOTHING. `findVetoes` has already refused the
 * pair by the time this is called; all this does is choose how to say so.
 * That separation is the point of deleting the old `proofExcluded` gate: one
 * mechanism makes the decision, and this just narrates it.
 *
 * The proof case gets his own wording rather than the generic veto sentence,
 * because it is the one outcome that will surprise him -- it is why a silent
 * second shot of a proof coin does not follow the shot that names the grade:
 *
 *     "not if the inventory item is described as a proof and the pictures
 *      don't contain that descriptor Proof/PF. Proofs are always described
 *      as such in the inventory as well as the pictures."
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
 * Does this coin fit the filename as well as the sibling's coin does?
 *
 * GATE F, and the one gate that is not in the owner's sentence. It asks the
 * question his worked example turns on: having found a coin by inference, is
 * there anything ELSE in the inventory that the filename describes equally
 * well? If there is, the sibling has not actually identified anything and
 * the file stays listed.
 *
 * "Equally well" is deliberately generous about what counts as a rival --
 * same year, compatible denomination, compatible coin type, no veto --
 * because a generous rival test means a stingy stage, and stingy is the
 * direction asked for.
 *
 * THERE USED TO BE A SEPARATE `proofExcluded(file, coin)` CALL AFTER THE
 * VETO CHECK BELOW. It has been removed, not relaxed: a filename that says
 * nothing about the strike now states 'business', so a proof rival is
 * already thrown out by `findVetoes`. Keeping both would have been two
 * mechanisms for one rule -- see the note in this file's header.
 */
function fitsEquallyWell(file: Signature, coin: Signature): boolean {
  if (file.year === null || coin.year === null) return false;
  const end = coin.yearRangeEnd ?? coin.year;
  if (file.year < coin.year || file.year > end) return false;

  // A denomination stated on both sides has to be compatible. Silence on
  // either side is not evidence against, so it leaves the coin a rival.
  if (file.denomination && coin.denomination
      && !denominationsAgree(file.denomination, coin.denomination)) {
    return false;
  }

  if (file.coinTypeTokens.length > 0 && coin.coinTypeTokens.length > 0
      && diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens) < COIN_TYPE_STRONG_SIMILARITY) {
    return false;
  }

  // The strike is in here too, via the veto: a proof coin is not a rival for
  // a filename that stays quiet, because that filename says "business".
  if (findVetoes(file, coin).vetoed) return false;

  return true;
}

/**
 * The year and the coin type agree -- the owner's FIRST condition.
 *
 * The year must be stated on both sides and must match; silence is not
 * agreement, which is the matcher's oldest rule and the reason an undated
 * ancient can never be placed this way.
 *
 * The coin type is softer, and it has to be. His three-cent records carry
 * the type "Three Cent Silver", every word of which the denomination has
 * already accounted for, so `parseCoin` quite correctly leaves the coin-type
 * token list EMPTY -- and his filenames say "3CS" and leave it empty too.
 * Demanding a positive type agreement there would switch this stage off for
 * the entire Early Proofs collection. So: when both sides name a type they
 * must agree at the same bar the scorer uses, and when either side is silent
 * the type simply does not speak. The denomination veto and gate G are what
 * carry the weight in that case.
 */
function yearAndTypeAgree(file: Signature, coin: Signature): boolean {
  if (file.year === null || coin.year === null) return false;
  const end = coin.yearRangeEnd ?? coin.year;
  if (file.year < coin.year || file.year > end) return false;

  if (file.coinTypeTokens.length === 0 || coin.coinTypeTokens.length === 0) return true;
  return diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens) >= COIN_TYPE_STRONG_SIMILARITY;
}

/**
 * Place the photographs that a sibling can identify, and leave everything
 * else exactly as it was.
 *
 * Pure: it returns a new array and never mutates the results handed in.
 * Order is preserved, one result in one result out, because the service's
 * contract is that `matchImages` answers in the order it was asked.
 *
 * @param results      every image in the batch, already decided and tiered.
 * @param coinSignatures the same precomputed inventory the decider used.
 */
export function inferFromSiblings(
  results: readonly ImageMatchResult[],
  coinSignatures: readonly CoinSignature[]
): ImageMatchResult[] {
  const byId = new Map(coinSignatures.map(entry => [entry.coin.id, entry]));

  /* The identified photographs: the ones that cleared all three auto gates
   * on their own merits. Only these may vouch for a sibling. A 'near' row is
   * a QUESTION the user has not answered yet and cannot vouch for anything,
   * and a row placed BY this stage cannot either -- inference never chains,
   * so one match can never be walked two files away from its evidence. */
  const identified = results
    .filter(result => result.tier === 'matched' && result.matchedRecordId)
    .map(result => ({
      result,
      coinId: result.matchedRecordId!,
      identifying: identifyingTokens(result.parsed.tokens, result.parsed.take ?? null)
    }));

  if (identified.length === 0) return [...results];

  return results.map(result => {
    // GATE A: this stage only ever fills a gap.
    if (result.tier === 'matched') return result;
    // GATE B: a stamp, a group shot or a camera default name has nothing to
    // infer from and no coin to infer about.
    //
    // `excludedFromAutoImport` is in the same breath, and it has to be: this
    // stage is the one place a photograph can acquire a coin WITHOUT passing
    // the three gates, so leaving it out would be a side door straight past
    // the owner's rule. A counterfeit shot is a textbook sibling of the
    // genuine article -- "FAKE - 1860 3CS - VF - Obverse" shares its year,
    // denomination and grade with his real 1860 3CS photographs -- and
    // without this line a placed genuine photo would drag the fake along
    // behind it. "Ignore the Fake coins" means here too.
    if (result.parsed.excludedFromAutoImport) return result;
    if (result.parsed.isNonCoin || result.parsed.isEmpty) return result;

    const identifying = identifyingTokens(result.parsed.tokens, result.parsed.take ?? null);

    /* A year on its own is not a family resemblance. Requiring the year AND
     * something else is what stops "1861 - Obverse.jpg" from claiming
     * kinship with every 1861 photograph in the batch. */
    if (result.parsed.year === null || identifying.size < 2) return result;

    // GATE C: every sibling must point at the SAME coin.
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

    // GATE D: "It should infer a match if the year and type match..."
    if (!yearAndTypeAgree(file, entry.signature)) return result;

    /* GATE E: the ordinary hard vetoes -- AND, SINCE THE OWNER'S RULE
     * LANDED, HIS PROOF EXCLUSION TOO.
     *
     * "...but not if the inventory item is described as a proof and the
     *  pictures don't contain that descriptor Proof/PF."
     *
     * That used to be a separate gate F immediately below this one. It is
     * gone, because a filename that says nothing about the strike is now
     * read as saying "business strike" (proof-strike.ts), which makes it a
     * stated conflict with a proof record and so a veto in its own right.
     * The long note in this file's header walks through every combination
     * and shows the old gate could no longer fire.
     *
     * The REASON is still reported rather than swallowed, because this is
     * the outcome most likely to surprise him: it is why a silent second
     * shot of a proof coin does not follow the shot that names the grade. */
    const verdict = findVetoes(file, entry.signature);
    if (verdict.vetoed) {
      return {
        ...result,
        skipReason: `${result.skipReason ?? ''} ${
          explainInferenceVeto(file, entry.signature, entry.label, verdict)
        }`.trim()
      };
    }

    // GATE F: no other coin in the inventory fits this filename just as well.
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

    /* PLACED. `status` is set to 'auto' alongside the tier on purpose: this
     * row really is attached, and the import-tier census asserts that tier 1
     * and the attached set are the same set. Letting them disagree would
     * hide an attachment from the one test that counts them. */
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
