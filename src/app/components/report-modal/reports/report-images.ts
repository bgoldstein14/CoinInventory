/*
 * report-images.ts — photographs on a printed report.
 *
 * Stored photographs are about 250 KB each, so embedding them as-is would
 * make a large report too big to print. Photographs are optional, capped per
 * coin, downscaled to thumbnails, loaded one coin at a time, and limited by a
 * total byte budget. Every omission is counted and described on the document.
 * Loading and downscaling are injected so the logic is testable without a DOM.
 */

import { CoinRecord } from '../../../types/coin.model';
import { coinHasPhotos, coinPhotoCount, makeCoinImageLoader } from '../../../services/coin-photos';

/** Obverse and reverse. */
export const IMAGES_PER_COIN_CAP = 2;

/** Longest edge of the thumbnail embedded in the report. */
export const THUMBNAIL_MAX_EDGE_PX = 480;

/**
 * Hard ceiling on embedded photographs in one report (about 950 thumbnails).
 * Only a pathological report reaches it; the document says when it does.
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

// Re-exported from services/coin-photos.ts, which skips the fetch for coins with no photographs.
export { coinHasPhotos, coinPhotoCount, makeCoinImageLoader };

/**
 * Decide which photographs to request. Reads counts only, never image
 * payloads, and returns the accounting the document uses to describe omissions.
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

/** Approximate decoded size of a base64 `data:` URL (3 bytes per 4 characters). */
export function estimateDataUrlBytes(dataUrl: string): number {
  if (!dataUrl) return 0;
  const comma = dataUrl.indexOf(',');
  const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  return Math.floor((payload * 3) / 4);
}

export interface ImageCollectorDeps {
  /** Every stored photograph for one coin, in display order. */
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
 * Walk the plan and return thumbnails. Sequential on purpose: a Promise.all
 * would hold every coin's full-size originals in memory at once. A coin whose
 * photographs fail to load is counted, not thrown.
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
    for (const original of originals.slice(0, request.take)) {
      let thumbnail: string;
      try {
        thumbnail = await deps.toThumbnail(original);
      } catch {
        // Counted with the size drops; either way the document reports it missing.
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
 * The plain-English note about photographs, distinguishing coins with no
 * photograph on file from photographs the report left out.
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
