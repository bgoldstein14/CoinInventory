import { describe, expect, it } from 'vitest';
import { ImageMatchingService } from './image-matching.service';

describe('ImageMatchingService', () => {
  it('matches image file names to the correct coin record by similarity', () => {
    const service = new ImageMatchingService();
    const images = ['mercury_dime_1945.jpg', 'mystery_coin.jpg'];
    const inventory = [
      {
        id: 'c1',
        name: 'Mercury Dime',
        denomination: '10 Cents',
        country: 'United States',
        category: 'Silver Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'XF',
        type: 'Mercury',
        year: 1945,
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual'
      },
      {
        id: 'c2',
        name: 'Liberty Head Double Eagle',
        denomination: '20 Dollar',
        country: 'United States',
        category: 'Gold Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'MS64',
        type: 'Liberty Head',
        year: 1907,
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual'
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
    const inventory = [
      {
        id: 'c1',
        name: 'Liberty Head Double Eagle',
        denomination: '20 Dollar',
        country: 'United States',
        category: 'Gold Coin',
        purchasePrice: 0,
        currentValue: 0,
        grade: 'MS64',
        type: 'Liberty Head',
        year: 1907,
        notes: '',
        certCompany: '',
        certNumber: '',
        variety: '',
        mintMark: '',
        composition: '',
        purchaseDate: '',
        imagePaths: [],
        tags: [],
        source: 'manual'
      }
    ];

    const matches = service.matchImages(['DOUBLE_EAGLE_LIBERTY_HEAD.JPG'], inventory);

    expect(matches[0].matchedRecordId).toBe('c1');
    expect(matches[0].confidence).toBeGreaterThan(0);
  });
});
