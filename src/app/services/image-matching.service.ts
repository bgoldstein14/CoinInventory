import { Injectable } from '@angular/core';
import { CoinRecord, ImageMatchCandidate } from '../types/coin.model';

@Injectable({ providedIn: 'root' })
export class ImageMatchingService {
  matchImages(imagePaths: string[], inventory: CoinRecord[]): ImageMatchCandidate[] {
    const mapped: ImageMatchCandidate[] = [];

    for (const imagePath of imagePaths) {
      const imageName = this.normalizeFileName(imagePath);
      let bestRecord: CoinRecord | null = null;
      let bestScore = 0;

      for (const coin of inventory) {
        const candidateName = this.normalizeFileName(coin.name);
        const score = this.similarity(imageName, candidateName);
        if (score > bestScore) {
          bestScore = score;
          bestRecord = coin;
        }
      }

      mapped.push({
        imagePath,
        matchedRecordId: bestRecord ? bestRecord.id : null,
        confidence: bestRecord ? Number(bestScore.toFixed(2)) : 0,
        reason: bestRecord
          ? `Matched ${bestRecord.name} based on filename similarity.`
          : 'No inventory record matched the image filename.'
      });
    }

    return mapped;
  }

  private normalizeFileName(value: string): string {
    return value
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  private similarity(left: string, right: string): number {
    if (!left || !right) return 0;
    const leftTokens = new Set(left.split(' '));
    const rightTokens = new Set(right.split(' '));
    const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size || 1;
    return overlap / union;
  }
}
