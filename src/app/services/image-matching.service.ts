import { Injectable } from '@angular/core';
import { CoinRecord, ImageMatchCandidate } from '../types/coin.model';

interface ParsedFileSignature {
  terms: string[];
  year: number | null;
  mintMarks: string[];
  denominationTerms: string[];
  typeTerms: string[];
}

@Injectable({ providedIn: 'root' })
export class ImageMatchingService {
  matchImages(imagePaths: string[], inventory: CoinRecord[]): ImageMatchCandidate[] {
    const mapped: ImageMatchCandidate[] = [];

    for (const imagePath of imagePaths) {
      const imageSignature = this.parseFileSignature(imagePath);
      let bestRecord: CoinRecord | null = null;
      let bestScore = 0;
      let bestReason = 'No inventory record matched the image filename.';

      for (const coin of inventory) {
        const coinSignature = this.parseCoinSignature(coin);
        const score = this.scoreMatch(imageSignature, coinSignature);

        if (score > bestScore) {
          bestScore = score;
          bestRecord = coin;
          bestReason = this.matchReason(imageSignature, coinSignature, score);
        }
      }

      const matchLabel = bestRecord
        ? [bestRecord.coinType, bestRecord.denomination, bestRecord.year].filter(Boolean).join(' ')
        : '';

      mapped.push({
        imagePath,
        matchedRecordId: bestRecord && bestScore >= 0.55 ? bestRecord.id : null,
        confidence: bestRecord ? Number(bestScore.toFixed(2)) : 0,
        reason: bestRecord
          ? bestReason || `Matched ${matchLabel} based on filename parsing.`
          : 'No inventory record matched the image filename.'
      });
    }

    return mapped;
  }

  private parseFileSignature(value: string): ParsedFileSignature {
    const normalized = this.normalizeValue(value);
    const terms = normalized.split(/\s+/).filter(Boolean);
    const year = this.extractYear(normalized);
    const mintMarks = this.extractMintMarks(terms);
    const denominationTerms = this.extractDenominationTerms(terms);
    const typeTerms = terms.filter((term) => !this.isStopWord(term) && !this.isMintMark(term) && !this.isDenominationWord(term) && term !== `${year ?? ''}`);

    return { terms, year, mintMarks, denominationTerms, typeTerms };
  }

  private parseCoinSignature(coin: CoinRecord): ParsedFileSignature {
    const fields = [coin.coinType, coin.denomination, coin.year, coin.mintMark].filter(Boolean).join(' ');
    const normalized = this.normalizeValue(fields);
    const terms = normalized.split(/\s+/).filter(Boolean);
    const year = this.extractYear(normalized);
    const mintMarks = this.extractMintMarks(terms);
    const denominationTerms = this.extractDenominationTerms(terms);
    const typeTerms = terms.filter((term) => !this.isStopWord(term) && !this.isMintMark(term) && !this.isDenominationWord(term) && term !== `${year ?? ''}`);

    return { terms, year, mintMarks, denominationTerms, typeTerms };
  }

  private scoreMatch(fileSig: ParsedFileSignature, coinSig: ParsedFileSignature): number {
    if (!fileSig.terms.length || !coinSig.terms.length) return 0;

    let score = 0;

    if (fileSig.year && coinSig.year && fileSig.year === coinSig.year) {
      score += 0.4;
    } else if (fileSig.year && coinSig.year && Math.abs(fileSig.year - coinSig.year) <= 1) {
      score += 0.15;
    }

    const mintScore = this.tokenSimilarity(fileSig.mintMarks, coinSig.mintMarks, 0.25);
    score += mintScore;

    if (fileSig.terms.includes('double') && fileSig.terms.includes('eagle') && (coinSig.terms.includes('dollar') || coinSig.denominationTerms.includes('dollar'))) {
      score += 0.3;
    }

    if (fileSig.terms.includes('liberty') && fileSig.terms.includes('head') && coinSig.terms.includes('liberty') && coinSig.terms.includes('head')) {
      score += 0.2;
    }

    const denominationScore = this.tokenSimilarity(fileSig.denominationTerms, coinSig.denominationTerms, 0.3);
    score += denominationScore;

    const typeScore = this.tokenSimilarity(fileSig.typeTerms, coinSig.typeTerms, 0.25);
    score += typeScore;

    const fileAll = new Set([...fileSig.terms, ...fileSig.mintMarks, ...fileSig.denominationTerms]);
    const coinAll = new Set([...coinSig.terms, ...coinSig.mintMarks, ...coinSig.denominationTerms]);
    if (fileAll.size && coinAll.size) {
      const shared = [...fileAll].filter((token) => coinAll.has(token)).length;
      const union = new Set([...fileAll, ...coinAll]).size || 1;
      const sharedRatio = shared / union;
      score += sharedRatio * 0.15;
    }

    return Math.min(1, score);
  }

  private matchReason(fileSig: ParsedFileSignature, coinSig: ParsedFileSignature, score: number): string {
    const reasons: string[] = [];
    if (fileSig.year && coinSig.year && fileSig.year === coinSig.year) reasons.push('year');
    if (this.tokenSimilarity(fileSig.denominationTerms, coinSig.denominationTerms, 0.3) > 0) reasons.push('denomination');
    if (this.tokenSimilarity(fileSig.mintMarks, coinSig.mintMarks, 0.25) > 0) reasons.push('mint mark');
    if (this.tokenSimilarity(fileSig.typeTerms, coinSig.typeTerms, 0.25) > 0) reasons.push('coin type');

    if (!reasons.length) return `Weak filename match: best score ${score.toFixed(2)}.`;
    return `Likely match based on ${reasons.join(', ')} (score ${score.toFixed(2)}).`;
  }

  private tokenSimilarity(leftTokens: string[], rightTokens: string[], maxWeight: number): number {
    if (!leftTokens.length || !rightTokens.length) return 0;
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
    if (!intersection) return 0;
    const combined = new Set([...leftSet, ...rightSet]).size || 1;
    return (intersection / combined) * maxWeight;
  }

  private normalizeValue(value: string): string {
    return value
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_/\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractYear(value: string): number | null {
    const match = value.match(/\b(17|18|19|20)\d{2}\b/);
    return match ? Number(match[0]) : null;
  }

  private extractMintMarks(tokens: string[]): string[] {
    const mintMarks = new Set<string>();
    for (const token of tokens) {
      if (['p', 'd', 's', 'w', 'o', 'c', 'cc', 'mm'].includes(token)) mintMarks.add(token);
      if (token === 'philadelphia' || token === 'philly') mintMarks.add('p');
      if (token === 'denver') mintMarks.add('d');
      if (token === 'san' && tokens.includes('francisco')) mintMarks.add('s');
      if (token === 'carson' && tokens.includes('city')) mintMarks.add('cc');
    }
    return [...mintMarks];
  }

  private extractDenominationTerms(terms: string[]): string[] {
    const results: string[] = [];
    const values = terms.join(' ');
    if (/(double\s*eagle|20\s*\$|twenty\s*dollar|twenty dollar)/.test(values)) {
      results.push('twenty', 'dollar');
    }
    if (/(half|50|halfdollar|half dollar)/.test(values)) results.push('half');
    if (/(quarter|25)/.test(values)) results.push('quarter');
    if (/(dime|10)/.test(values)) results.push('dime');
    if (/(nickel|5)/.test(values)) results.push('nickel');
    if (/(cent|penny|1c|1 cent|one cent)/.test(values)) results.push('cent');
    if (/(dollar|1dollar|100c|1\s*\$|\$1|eagle)/.test(values)) results.push('dollar');
    if (/(20\s*\$|twenty)/.test(values)) results.push('twenty');
    if (/(three\s*cent|3c|3\s*cent|3cn)/.test(values)) results.push('three');
    if (/(two\s*cent|2c|2\s*cent|2c)/.test(values)) results.push('two');
    return [...new Set(results)];
  }

  private isStopWord(term: string): boolean {
    return new Set(['jpg', 'jpeg', 'png', 'webp', 'coin', 'coins', 'front', 'back', 'obverse', 'reverse', 'photo', 'scan', 'image', 'raw', 'img', 'pic']).has(term);
  }

  private isMintMark(term: string): boolean {
    return ['p', 'd', 's', 'w', 'o', 'c', 'cc', 'mm'].includes(term);
  }

  private isDenominationWord(term: string): boolean {
    return ['half', 'quarter', 'dime', 'nickel', 'cent', 'dollar', 'twenty', 'three', 'two'].includes(term);
  }
}
