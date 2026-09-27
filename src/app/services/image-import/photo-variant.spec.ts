import { describe, expect, it } from 'vitest';
import { ParsedImageAttributes } from '../../types/coin.model';
import {
  describePhoto,
  sideLabel,
  sideSortOrder,
  takeNumberFromFileName
} from './photo-variant';

/** An empty parse, so we can bolt speculative extra fields onto it. */
function parsed(extra: Record<string, unknown> = {}): ParsedImageAttributes {
  return {
    fileName: 'x.jpg', year: null, mintMark: null, denomination: null,
    denominationLabel: null, coinTypeTokens: [], grade: null, certNumbers: [],
    certCompanies: [], tokens: [], isEmpty: true,
    ...extra
  } as ParsedImageAttributes;
}

describe('describePhoto - reading the side out of real share filenames', () => {
  it('reads Obverse / Reverse / Label', () => {
    expect(describePhoto('1880-S $1 - MS64 - Obverse - Photo.jpg').side).toBe('obverse');
    expect(describePhoto('1880-S $1 - MS64 - Reverse - Photo.jpg').side).toBe('reverse');
    expect(describePhoto('1870 1-cent NGC PF65RB - Label.jpg').side).toBe('label');
  });

  it('returns unknown when the name does not say', () => {
    expect(describePhoto('1874 $3 - NGC AU 58-2.jpg').side).toBe('unknown');
    expect(describePhoto('Gold Coins.JPG').side).toBe('unknown');
    expect(describePhoto('IM000025.JPG').side).toBe('unknown');
  });

  it('is not fooled by "rev" inside a longer word', () => {
    // "67-68 CE 1st Revolt - Obverse - Sharpened.jpg" is an OBVERSE.
    expect(describePhoto('67-68 CE 1st Revolt - Obverse - Sharpened.jpg').side).toBe('obverse');
  });
});

describe('describePhoto - variants and retakes', () => {
  it('spots the processing-variant word and marks derivatives as retakes', () => {
    const small = describePhoto('1812 50c VG - Obverse - Small.jpg');
    expect(small.variant).toBe('Small');
    expect(small.isRetake).toBe(true);

    const orig = describePhoto('1875 20c - VF+ - Obverse - Orig.jpg');
    expect(orig.variant).toBe('Orig');
    expect(orig.isRetake).toBe(true);

    const sharpened = describePhoto('67-68 CE 1st Revolt - Reverse - Sharpened.jpg');
    expect(sharpened.variant).toBe('Sharpened');
    expect(sharpened.isRetake).toBe(true);
  });

  it('does NOT treat "- Photo" as a retake: it is the original shot', () => {
    const photo = describePhoto('1865 3CN - Choice VF - Obverse - Photo.jpg');
    expect(photo.variant).toBe('Photo');
    expect(photo.isRetake).toBe(false);
  });

  it('does not mistake a coin type containing "Small" for a file variant', () => {
    // "1795 $5 Small Eagle - Obverse.jpg": "Small" is part of the design name,
    // and sits in the middle of the name rather than at the end.
    const row = describePhoto('1795 $5 Small Eagle - Obverse.jpg');
    expect(row.variant).toBeNull();
    expect(row.isRetake).toBe(false);
  });

  it('reads a trailing take number and treats take 2+ as a retake', () => {
    expect(describePhoto('1874 $3 - NGC AU 58-2.jpg').takeNumber).toBe(2);
    expect(describePhoto('1874 $3 - NGC AU 58-2.jpg').isRetake).toBe(true);
    expect(describePhoto('2008 Hawaii Quarter - Dropped D - 2.JPG').isRetake).toBe(true);
    // Take 1 is the first shot, not a retake.
    expect(describePhoto('1875-1.jpg').takeNumber).toBe(1);
    expect(describePhoto('1875-1.jpg').isRetake).toBe(false);
  });

  it('does not read a grade or a year as a take number', () => {
    expect(takeNumberFromFileName('1906-S $5 - XF-AU.jpg')).toBeNull();
    expect(takeNumberFromFileName('1904 $20 - PCGS MS63.jpg')).toBeNull();
    // Four digits is never a take.
    expect(takeNumberFromFileName('Coin - 1881.jpg')).toBeNull();
  });
});

describe('describePhoto - defensive use of the matcher fields', () => {
  it('works when the matcher supplies no side/take fields at all (today)', () => {
    const info = describePhoto('1880-S $1 - Obverse.jpg', parsed());
    expect(info.side).toBe('obverse');
    expect(info.takeNumber).toBeNull();
  });

  it('prefers a flat side field when the matcher adds one', () => {
    // The filename says nothing; the matcher does.
    const info = describePhoto('IM000025.JPG', parsed({ side: 'reverse' }));
    expect(info.side).toBe('reverse');
  });

  it('prefers a nested marker object when the matcher nests the fields', () => {
    const info = describePhoto('IM000025.JPG', parsed({
      photoMarkers: { side: 'label', take: 3, variant: 'small' }
    }));
    expect(info.side).toBe('label');
    expect(info.takeNumber).toBe(3);
    expect(info.variant).toBe('Small');
    expect(info.isRetake).toBe(true);
  });

  it('accepts abbreviated and differently-cased side values', () => {
    expect(describePhoto('x.jpg', parsed({ photoSide: 'OBV' })).side).toBe('obverse');
    expect(describePhoto('x.jpg', parsed({ photoSide: 'Reverse' })).side).toBe('reverse');
  });

  it('ignores a side value it does not understand and falls back to the name', () => {
    const info = describePhoto('1880-S $1 - Reverse.jpg', parsed({ side: 'edge-lettering' }));
    expect(info.side).toBe('reverse');
  });

  it('ignores a matcher "unknown" so our own read still gets a chance', () => {
    const info = describePhoto('1880-S $1 - Obverse.jpg', parsed({ side: 'unknown' }));
    expect(info.side).toBe('obverse');
  });

  it('ignores a nonsense take value', () => {
    expect(describePhoto('x.jpg', parsed({ take: 0 })).takeNumber).toBeNull();
    expect(describePhoto('x.jpg', parsed({ take: -2 })).takeNumber).toBeNull();
    expect(describePhoto('x.jpg', parsed({ take: '2nd' })).takeNumber).toBeNull();
    expect(describePhoto('x.jpg', parsed({ take: 2.5 })).takeNumber).toBeNull();
  });
});

describe('side ordering helpers', () => {
  it('sorts obverse, reverse, label, then everything else', () => {
    const sides = (['unknown', 'label', 'reverse', 'obverse'] as const)
      .slice()
      .sort((a, b) => sideSortOrder(a) - sideSortOrder(b));
    expect(sides).toEqual(['obverse', 'reverse', 'label', 'unknown']);
  });

  it('gives each side a display label', () => {
    expect(sideLabel('obverse')).toBe('Obverse');
    expect(sideLabel('reverse')).toBe('Reverse');
    expect(sideLabel('label')).toBe('Label');
    expect(sideLabel('unknown')).toBe('Other');
  });
});
