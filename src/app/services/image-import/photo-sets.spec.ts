import { describe, expect, it } from 'vitest';
import { BatchImageRow } from '../../types/coin.model';
import { parseFilename } from '../image-matching/filename-parser';
import { describePhoto } from './photo-variant';
import { groupPhotoSets, photoSetKey, setDescriptor, shotLabel } from './photo-sets';

/** Just enough of a review row for the set helpers: a real parse and photo read. */
function row(fileName: string): BatchImageRow {
  const parsed = parseFilename(fileName);
  return {
    fileName,
    photo: describePhoto(fileName, parsed),
    result: { parsed }
  } as unknown as BatchImageRow;
}

const key = (name: string) => photoSetKey(row(name));

describe('photoSetKey', () => {
  it('puts every shot of one coin in one set', () => {
    const base = key('1881 Morgan Dollar NGC 2599001 - Obverse.jpg');
    for (const other of [
      '1881 Morgan Dollar NGC 2599001 - Reverse.jpg',
      '1881 Morgan Dollar NGC 2599001 - Slab Label.jpg',
      '1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg',
      '1881 Morgan Dollar NGC 2599001 - Reverse - Small.jpg',
      '1881 Morgan Dollar NGC 2599001 - Obverse - Orig.JPG'
    ]) {
      expect(key(other), other).toBe(base);
    }
  });

  it('ignores word order', () => {
    expect(key('1861 3CS - Obverse - FAKE.jpg')).toBe(key('FAKE 1861 3CS - Reverse.jpg'));
  });

  it('keeps different coins apart', () => {
    expect(key('1881 Morgan Dollar PCGS MS63 - Obverse.jpg'))
      .not.toBe(key('1881 Morgan Dollar PCGS MS64 - Obverse.jpg'));
    // A quieter name is not merged into a louder one (equality, not containment).
    expect(key('1884 3CN - Obverse 2.jpg')).not.toBe(key('1884 3CN - PCGS PF65CAM - Obverse.jpg'));
    // A fake and the genuine coin of the same date are different coins.
    expect(key('1861 3CS - Obverse - FAKE.jpg')).not.toBe(key('1861 3CS - Reverse.jpg'));
  });

  it('never groups a name with a single identifying word', () => {
    expect(key('1861 - Obverse.jpg')).not.toBe(key('1861 - Reverse.jpg'));
  });

  it('never groups a multi-coin shot', () => {
    expect(key('1875 3CN - Collage.jpg')).not.toBe(key('1875 3CN - Collage - Small.jpg'));
  });
});

describe('groupPhotoSets', () => {
  it('collapses rows into sets in first-seen order, obverse first inside each', () => {
    const sets = groupPhotoSets([
      row('1881 Morgan Dollar NGC 2599001 - Reverse.jpg'),
      row('1922 Peace Dollar - Obverse.jpg'),
      row('1881 Morgan Dollar NGC 2599001 - Obverse.jpg'),
      row('1881 Morgan Dollar NGC 2599001 - Slab Label.jpg')
    ]);

    expect(sets).toHaveLength(2);
    expect(sets[0].descriptor).toBe('1881 Morgan Dollar NGC 2599001');
    expect(sets[0].rows.map(r => r.photo.side)).toEqual(['obverse', 'reverse', 'label']);
    expect(sets[0].leadFileName).toBe('1881 Morgan Dollar NGC 2599001 - Obverse.jpg');
    expect(sets[1].rows).toHaveLength(1);
  });
});

describe('setDescriptor', () => {
  it.each([
    ['1881 Morgan Dollar NGC 2599001 - Obverse 2.jpg', '1881 Morgan Dollar NGC 2599001'],
    ['1881 Morgan Dollar NGC 2599001 - Slab Label.jpg', '1881 Morgan Dollar NGC 2599001'],
    ['1861 3CS - Obverse - FAKE.jpg', '1861 3CS - FAKE'],
    ['1874 $3 - NGC AU 58-2.jpg', '1874 $3 - NGC AU 58'],
    ['1881 Morgan Dollar NGC 2599001.jpg', '1881 Morgan Dollar NGC 2599001']
  ])('%s -> %s', (file, expected) => {
    expect(setDescriptor(row(file))).toBe(expected);
  });
});

describe('shotLabel', () => {
  it.each([
    ['1881 Morgan - Obverse.jpg', 'Obverse'],
    ['1881 Morgan - Reverse 2.jpg', 'Reverse #2'],
    ['1881 Morgan - Slab Label.jpg', 'Label'],
    ['1881 Morgan - Obverse - Small.jpg', 'Obverse · Small'],
    ['1874 $3 - NGC AU 58-2.jpg', 'Shot #2'],
    ['1881 Morgan Dollar NGC 2599001.jpg', 'Photo']
  ])('%s -> %s', (file, expected) => {
    expect(shotLabel(row(file))).toBe(expected);
  });
});
