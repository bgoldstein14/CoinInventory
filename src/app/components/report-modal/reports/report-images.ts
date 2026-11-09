/*
 * report-images.ts — photographs on a printed report, without a 150 MB page.
 *
 * PHOTOGRAPHS ARE THE POINT AND ALSO THE DANGER. The one thing an insurance
 * schedule wants that a CSV physically cannot carry is a PHOTOGRAPH, so they
 * are the reason the feature exists. They are also the only way it can hurt
 * anybody: `CoinRecord.imagePaths` holds copies already downscaled to roughly
 * 1600px, about 250 KB of base64 each, and
 *
 *     300 coins x 2 photographs x 250 KB  ~=  150 MB
 *
 * in a single HTML string handed to a print renderer. That does not produce a
 * large PDF; it produces a browser that stops responding.
 *
 * THE FOUR DEFENCES, IN THE ORDER THEY APPLY
 *
 * 1. OPTIONAL. A tick-box on the report modal. The inventory listing never
 *    asks for photographs; the insurance schedule offers them and the user
 *    can turn them off for a quick draft.
 *
 * 2. CAPPED PER COIN at IMAGES_PER_COIN_CAP. Two: obverse and reverse. That
 *    is what a numismatic record IS, and it is what identifies a coin. A
 *    third angle doubles the page count and identifies nothing new.
 *
 * 3. DOWNSCALED AGAIN, to THUMBNAIL_MAX_EDGE_PX. The stored copy is sized for
 *    a full-screen viewer; the report prints it at about an inch. 480px at
 *    that size is roughly 430 dpi, past what any home printer resolves, and
 *    costs about a tenth of the bytes.
 *
 * 4. LOADED ONE COIN AT A TIME, with the full-size original dropped as soon
 *    as its thumbnail exists. `GET /api/coins` omits image payloads by
 *    default, so `imagePaths` is ABSENT and images are fetched per coin;
 *    keeping the collector a sequential walk means a 400-coin report never
 *    has more than one coin's originals live.
 *
 * THE COLLECTOR TAKES ITS DEPENDENCIES AS FUNCTIONS because the frontend
 * suite runs under Node with no jsdom and no HTTP. Loading an image is an API
 * call and downscaling one is a `<canvas>`, so both are injected; what is
 * left — the sequencing, the caps, the budget accounting and the "one coin
 * failing must not fail the report" rule — is ordinary, tested logic.
 */

import { CoinRecord } from '../../../types/coin.model';
import { coinHasPhotos, coinPhotoCount, makeCoinImageLoader } from '../../../services/coin-photos';

/** Obverse and reverse. See defence 2 in the header. */
export const IMAGES_PER_COIN_CAP = 2;

/** Longest edge of the thumbnail embedded in the report. See defence 3. */
export const THUMBNAIL_MAX_EDGE_PX = 480;

/**
 * Hard ceiling on the embedded photographs in one report.
 *
 * 24 MB is deliberately generous — at roughly 25 KB a thumbnail it is about
 * 950 photographs — and exists only to stop a pathological case (a thousand
 * coins, or thumbnails that did not compress) turning a print into a hang.
 * When it does bite, the document SAYS SO rather than quietly printing fewer
 * photographs than the user asked for.
 */
export const REPORT_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

export interface ImageRequest {
  coinId: string;
  /** How many of this coin's photographs to embed; never more than the cap. */
  take: number;
}

export interface ImagePlan {
  requests: ImageRequest[];
  /** Coins with no photograph on file at all. Stated on the document. */
  coinsWithoutPhotos: number;
  /** Photographs skipped because their coin has more than the per-coin cap. */
  photosBeyondPerCoinCap: number;
  /** Total photographs the plan intends to embed. */
  requestedPhotos: number;
}

/*
 * Re-exported, not defined here. services/coin-photos.ts is the one
 * definition of "how many photographs does this coin have" and "give me
 * them, fetching only if I must" — it skips the fetch entirely for a coin
 * whose `imageCount` is 0 and caches per coin, which over a schedule where
 * half the coins have no photograph is ~50 round trips not made.
 */
export { coinHasPhotos, coinPhotoCount, makeCoinImageLoader };

/**
 * Decide what to ask for, before asking for any of it.
 *
 * Pure and cheap: it reads counts only, never image payloads, so planning a
 * 400-coin report costs nothing. The accounting it returns is what lets the
 * finished document own up to what it left out.
 */
export function planReportImages(
  coins: readonly CoinRecord[],
  perCoinCap: number = IMAGES_PER_COIN_CAP
): ImagePlan {
  const requests: ImageRequest[] = [];
  let coinsWithoutPhotos = 0;
  let photosBeyondPerCoinCap = 0;
  let requestedPhotos = 0;

  for (const coin of coins) {
    const available = coinPhotoCount(coin);
    if (available <= 0) {
      coinsWithoutPhotos++;
      continue;
    }

    const take = Math.min(available, perCoinCap);
    photosBeyondPerCoinCap += available - take;
    requestedPhotos += take;
    requests.push({ coinId: coin.id, take });
  }

  return { requests, coinsWithoutPhotos, photosBeyondPerCoinCap, requestedPhotos };
}

/**
 * Decoded size of a base64 `data:` URL, near enough for budget arithmetic.
 *
 * Base64 carries 3 bytes in every 4 characters. Padding and the `data:` MIME
 * prefix make this an approximation, and an approximation is all the budget
 * needs — the alternative is decoding every image to measure it, which is the
 * expensive thing this is trying to avoid.
 */
export function estimateDataUrlBytes(dataUrl: string): number {
  if (!dataUrl) return 0;
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  return Math.floor((payload * 3) / 4);
}

export interface ImageCollectorDeps {
  /**
   * Every stored photograph for ONE coin, in display order.
   *
   * One coin, never the collection — that signature is the memory defence.
   */
  loadCoinImages(coinId: string): Promise<string[]>;

  toThumbnail(dataUrl: string): Promise<string>;

  /** Defaults to REPORT_IMAGE_BUDGET_BYTES. */
  budgetBytes?: number;
}

export interface CollectedImages {
  /** coinId -> thumbnails. Only ever thumbnails. */
  images: Map<string, string[]>;
  includedPhotos: number;
  /** Photographs left out because the byte budget was reached. */
  droppedForSize: number;
  /** Coins whose photographs could not be loaded at all. */
  failedCoins: number;
  /** Total embedded bytes, as estimated. */
  bytes: number;
}

/**
 * Walk the plan and come back with thumbnails.
 *
 * SEQUENTIAL ON PURPOSE. A `Promise.all` over the requests would be faster
 * and would hold every coin's full-size originals in memory at the same
 * moment, which is the exact 150 MB failure this module exists to prevent.
 * The loop awaits each coin, converts, and lets the originals fall out of
 * scope before the next iteration. Do not "optimise" this into a parallel
 * map.
 *
 * ONE COIN FAILING MUST NOT FAIL THE REPORT. A photograph that cannot be
 * read costs that coin its picture and nothing else; the failure is counted
 * and named on the document instead of thrown.
 */
export async function collectReportImages(
  plan: ImagePlan,
  deps: ImageCollectorDeps
): Promise<CollectedImages> {
  const budget = deps.budgetBytes ?? REPORT_IMAGE_BUDGET_BYTES;
  const images = new Map<string, string[]>();
  let includedPhotos = 0;
  let droppedForSize = 0;
  let failedCoins = 0;
  let bytes = 0;

  for (const request of plan.requests) {
    let originals: string[];
    try {
      originals = await deps.loadCoinImages(request.coinId);
    } catch {
      failedCoins++;
      continue;
    }

    const thumbnails: string[] = [];
    // `.slice` before the loop, so a coin that turns out to have twenty
    // photographs still only costs us the cap's worth of conversions.
    for (const original of originals.slice(0, request.take)) {
      let thumbnail: string;
      try {
        thumbnail = await deps.toThumbnail(original);
      } catch {
        // One unreadable photograph on an otherwise fine coin. Count it with
        // the size drops rather than failing the coin: either way the
        // document says a photograph is missing.
        droppedForSize++;
        continue;
      }

      const cost = estimateDataUrlBytes(thumbnail);
      if (bytes + cost > budget) {
        droppedForSize++;
        continue;
      }

      bytes += cost;
      includedPhotos++;
      thumbnails.push(thumbnail);
    }

    if (thumbnails.length > 0) images.set(request.coinId, thumbnails);
  }

  return { images, includedPhotos, droppedForSize, failedCoins, bytes };
}

/** "1 photograph" / "4 photographs". */
function pluralPhotos(count: number): string {
  return count === 1 ? '1 photograph' : `${count} photographs`;
}

/** "1 coin" / "4 coins". */
function pluralCoins(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/**
 * The plain-English paragraph printed under the photographs.
 *
 * Every omission this module makes is named here, which is why the plan and
 * the collector return accounting rather than just pictures. A reader
 * holding an insurance schedule has to be able to tell "this coin has no
 * photograph on file" from "the report decided not to show you this one" —
 * the first is a gap in the collection's records, the second a gap in the
 * document, and only one of them is the owner's to fix.
 */
export function describeReportImages(plan: ImagePlan, collected: CollectedImages): string {
  const sentences: string[] = [
    `${pluralPhotos(collected.includedPhotos)} included, at up to ${THUMBNAIL_MAX_EDGE_PX}px each.`
  ];

  if (plan.photosBeyondPerCoinCap > 0) {
    sentences.push(
      `Where a coin has more than ${IMAGES_PER_COIN_CAP} photographs on file, only the first ${IMAGES_PER_COIN_CAP} are shown.`
    );
  }

  if (plan.coinsWithoutPhotos > 0) {
    sentences.push(
      `${pluralCoins(plan.coinsWithoutPhotos)} ${plan.coinsWithoutPhotos === 1 ? 'has' : 'have'} no photograph on file.`
    );
  }

  if (collected.droppedForSize > 0) {
    sentences.push(
      `${pluralPhotos(collected.droppedForSize)} could not be included because the document would otherwise be too large to print.`
    );
  }

  if (collected.failedCoins > 0) {
    sentences.push(
      `The photographs for ${pluralCoins(collected.failedCoins)} could not be read and were left out.`
    );
  }

  return sentences.join(' ');
}
