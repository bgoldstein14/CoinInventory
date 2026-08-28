import { describe, expect, it } from 'vitest';
import { ImageMatchingService } from './image-matching.service';

describe('ImageMatchingService', () => {
  it('matches image file names to the correct coin record by similarity', () => {
    const service = new ImageMatchingService();
    const images = ['mercury_dime_1945.jpg', 'mystery_coin.jpg'];
    // Updated CoinRecord structure: no 'name', 'type' -> 'coinType', year is string
    const inventory = [
      {
        id: 'c1',
        denomination: 'Dime',
        coinType: 'Mercury',
        year: '1945',
        country: 'United States',
        category: 'Silver Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'XF',
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual' as const
      },
      {
        id: 'c2',
        denomination: '20 Dollar',
        coinType: 'Liberty Head',
        year: '1907',
        country: 'United States',
        category: 'Gold Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'MS64',
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual' as const
      }
    ];

    const matches = service.matchImages(images, inventory);

    expect(matches[0].matchedRecordId).toBe('c1');
    expect(matches[0].confidence).toBeGreaterThan(0.5);
    expect(matches[1].matchedRecordId).toBeNull();
    expect(matches[1].reason).toContain('No inventory record matched');
  });

  it('matches case-insensitive names and ignores file extensions', () => {
    const service = new ImageMatchingService();
    // Updated CoinRecord structure: no 'name', 'type' -> 'coinType', year is string
    const inventory = [
      {
        id: 'c1',
        denomination: '20 Dollar',
        coinType: 'Liberty Head',
        year: '1907',
        country: 'United States',
        category: 'Gold Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'MS64',
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual' as const
      }
    ];

    const matches = service.matchImages(['DOUBLE_EAGLE_LIBERTY_HEAD.JPG'], inventory);

    expect(matches[0].matchedRecordId).toBe('c1');
    expect(matches[0].confidence).toBeGreaterThan(0);
  });
});
