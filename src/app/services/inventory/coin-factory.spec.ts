/**
 * Tests for the coin factory. Old JSON exports still carry a removed
 * `"tags": [...]` field on every coin; they must still import (the key is
 * ignored, not rejected), so a stricter `normalizeImportedCoins` can't break
 * reading old backups.
 */
import { describe, expect, it } from 'vitest';
import { createBlankCoin, normalizeImportedCoins } from './coin-factory';
import { CoinRecord } from '../../types/coin.model';
import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';

/**
 * A coin as it appears in an export from before tags were removed. Typed
 * `Record<string, unknown>` because it models parsed JSON the compiler never
 * checked (a `CoinRecord` literal with `tags` wouldn't compile).
 */
const OLD_FORMAT_EXPORT: Record<string, unknown> = {
  id: 'legacy-1',
  denomination: '$1',
  year: '1921',
  coinType: 'Morgan',
  category: '20th Cent. Type',
  country: 'United States',
  grade: 'MS64',
  certCompany: 'PCGS',
  certNumber: '12345678',
  variety: '',
  mintMark: 'S',
  composition: '90% Silver',
  purchaseDate: '2019-04-02',
  purchasePrice: 120,
  currentValue: 180,
  notes: 'From the old export',
  imagePaths: [],
  // The removed field, populated (the harder case than an empty array).
  tags: ['key-date', 'rainbow toning'],
  source: 'manual',
  hasCacSticker: false,
};

describe('createBlankCoin()', () => {
  it('does not create a tags field', () => {
    // A blank coin must not POST `tags` to a backend that no longer accepts it.
    expect(createBlankCoin()).not.toHaveProperty('tags');
  });

  it('still initialises every field the editor expects', () => {
    const coin = createBlankCoin();

    expect(coin.id).toBeTruthy();
    expect(coin.imagePaths).toEqual([]);
    expect(coin.source).toBe('manual');
    expect(coin.country).toBe('United States');
    expect(coin.hasCacSticker).toBe(false);
  });
});

describe('normalizeImportedCoins() — backward compatibility with old exports', () => {
  it('imports a pre-removal coin that still carries a tags array', () => {
    // Parsed JSON is handed to the normaliser as if it were a CoinRecord.
    const [coin] = normalizeImportedCoins([OLD_FORMAT_EXPORT as unknown as CoinRecord]);

    // No throw, and every used field survived.
    expect(coin.id).toBe('legacy-1');
    expect(coin.denomination).toBe('$1');
    expect(coin.year).toBe('1921');
    expect(coin.coinType).toBe('Morgan');
    expect(coin.grade).toBe('MS64');
    expect(coin.certCompany).toBe('PCGS');
    expect(coin.notes).toBe('From the old export');
    expect(coin.source).toBe('manual');
    expect(coin.imagePaths).toEqual([]);
  });

  it('imports a whole old-format file without error', () => {
    // Several coins, as in a real backup file.
    const file = [
      OLD_FORMAT_EXPORT,
      { ...OLD_FORMAT_EXPORT, id: 'legacy-2', tags: [] },
      { ...OLD_FORMAT_EXPORT, id: 'legacy-3', tags: ['investment grade'] },
    ] as unknown as CoinRecord[];

    const coins = normalizeImportedCoins(file);

    expect(coins).toHaveLength(3);
    expect(coins.map(c => c.id)).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);
  });

  it('round-trips an old export through JSON.parse, the way an import really arrives', () => {
    // The real path: text -> parse -> normalise.
    const fileText = JSON.stringify([OLD_FORMAT_EXPORT]);

    const coins = normalizeImportedCoins(JSON.parse(fileText) as CoinRecord[]);

    expect(coins).toHaveLength(1);
    expect(coins[0].coinType).toBe('Morgan');
  });

  it('still fills in the gaps it has always filled in', () => {
    // The other repairs still work.
    const ragged = {
      id: '',
      imagePaths: 'not-an-array',
      source: '',
      grade: null,
      category: null,
      hasCacSticker: undefined,
      tags: ['ignored'],
    } as unknown as CoinRecord;

    const [coin] = normalizeImportedCoins([ragged]);

    expect(coin.id).toBeTruthy();              // a UUID was generated
    /* A wrong-typed `imagePaths` is removed, not replaced with `[]`: `[]` claims
     * the coin has no photos, and the gallery's next full-array PUT would delete
     * them. Absent means "not loaded"; the hydrator fetches the real set. JSON
     * exports no longer contain photos at all. */
    expect('imagePaths' in coin).toBe(false);
    expect(coin.source).toBe('manual');        // defaulted
    expect(coin.grade).toBe('');               // null -> empty string
    expect(coin.category).toBe('');
    expect(coin.hasCacSticker).toBe(false);
  });

  it('keeps a real imagePaths array, including a deliberately empty one', () => {
    // An export from when photos were inlined carries the key; a real array (even
    // `[]`) is a fact and must survive.
    const withPhotos = { id: 'a', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;
    const withoutPhotos = { id: 'b', imagePaths: [] } as unknown as CoinRecord;

    const [a, b] = normalizeImportedCoins([withPhotos, withoutPhotos]);

    expect(a.imagePaths).toEqual(['data:image/jpeg;base64,AAA']);
    expect('imagePaths' in b).toBe(true);
    expect(b.imagePaths).toEqual([]);
  });

  it('leaves imagePaths off entirely for a modern export, which has none', () => {
     /*
      * The normal case: exports come from `JSON.stringify(inventory())`, which has no
      * `imagePaths` (see server/routes/coins/list-query.ts). Importing one must not
      * mark the whole collection as having no photos.
      */
    const modernExport = { id: 'a', coinType: 'Morgan', imageCount: 4 } as unknown as CoinRecord;

    const [coin] = normalizeImportedCoins([modernExport]);

    expect('imagePaths' in coin).toBe(false);
  });
});

 /*
  * Collection status and storage on new and imported coins. Every older backup
  * lacks `collectionStatus`, which decides whether a coin counts toward the
  * collection's value; restoring them as anything but owned would quietly break
  * the totals.
  */

describe('collection status on a new coin', () => {
  it('starts Owned, explicitly', () => {
    // Set explicitly: the record is POSTed as-is and diffed against later.
    expect(createBlankCoin().collectionStatus).toBe('owned');
  });

  it('starts with an empty storage location rather than undefined', () => {
    expect(createBlankCoin().storageLocation).toBe('');
  });
});

describe('collection status when importing a JSON backup', () => {
  it('makes a coin with no status Owned', () => {
    // Every coin in every backup from before this field existed.
    const legacy = { id: 'legacy-1', denomination: '$1' } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([legacy]);

    expect(coin.collectionStatus).toBe('owned');
  });

  it('preserves a real status', () => {
    const wanted = { id: 'w-1', denomination: '$1', collectionStatus: 'wanted' } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([wanted]);

    expect(coin.collectionStatus).toBe('wanted');
  });

  it('falls back to Owned for a status it does not recognise', () => {
    // An unknown word (hand edit or newer build) doesn't drop the coin from the collection.
    const odd = { id: 'x-1', denomination: '$1', collectionStatus: 'on-loan' } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([odd]);

    expect(coin.collectionStatus).toBe('owned');
  });

  it('leaves a storage location exactly as the file had it', () => {
    // Free text, not normalised; absent means none.
    const stored = {
      id: 's-1', denomination: '$1', storageLocation: 'Dansco 7070, page 4'
    } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([stored]);

    expect(coin.storageLocation).toBe('Dansco 7070, page 4');
  });
});

 /*
  * The denomination link on a JSON restore (design §4.1): text is written as
  * given and linked where possible. An id already in the backup is the user's
  * saved answer and is never re-resolved.
  */
describe('normalizeImportedCoins() — linking denominations', () => {
  it('links a coin that has text and no id', () => {
    const file = [{ id: 'j-1', denomination: '$1', country: 'United States' }];
    const [coin] = normalizeImportedCoins(file as unknown as CoinRecord[], SEED_DENOMINATIONS);

    expect(coin.denominationId).toBe(seedDenomination('United States', '$1')!.denominationId);
    expect(coin.denomination).toBe('$1');
  });

  it('uses the coin\'s own country', () => {
    const file = [
      { id: 'j-1', denomination: 'Penny', country: 'Australia' },
      { id: 'j-2', denomination: 'Penny', country: 'United States' }
    ];
    const coins = normalizeImportedCoins(file as unknown as CoinRecord[], SEED_DENOMINATIONS);

    expect(coins[0].denominationId).toBe(seedDenomination('Australia', 'Penny')!.denominationId);
    // Three issuers struck a Penny; the United States isn't one of them.
    expect(coins[1].denominationId).toBeNull();
  });

  it('NEVER overwrites an id the backup already carried', () => {
    // The saved id wins, even where it disagrees with what the text would resolve to.
    const mexican = seedDenomination('Mexico', '8 Reales')!.denominationId;
    const file = [{
      id: 'j-1', denomination: 'Pillar Dollar', country: 'United States',
      denominationId: mexican
    }];
    const [coin] = normalizeImportedCoins(file as unknown as CoinRecord[], SEED_DENOMINATIONS);

    expect(coin.denominationId).toBe(mexican);
    expect(coin.denomination).toBe('Pillar Dollar');
  });

  it('leaves an unresolvable coin with its text and no link', () => {
    const file = [{ id: 'j-1', denomination: '8 Reales', country: 'United States' }];
    const [coin] = normalizeImportedCoins(file as unknown as CoinRecord[], SEED_DENOMINATIONS);

    expect(coin.denominationId).toBeNull();
    expect(coin.denomination).toBe('8 Reales');
  });

  it('restores exactly as it always did when no lookup is supplied', () => {
    // Callers without the lookup (not loaded yet) must still restore.
    const file = [{ id: 'j-1', denomination: '$1', country: 'United States' }];
    const [coin] = normalizeImportedCoins(file as unknown as CoinRecord[]);

    expect(coin.denomination).toBe('$1');
    expect(coin.denominationId).toBeNull();
  });
});

describe('createBlankCoin() and the denomination link', () => {
  it('starts with no link, because it starts with no denomination', () => {
    // Set explicitly: the record is POSTed as-is and diffed against later.
    expect(createBlankCoin().denominationId).toBeNull();
  });
});

describe('normalizeImportedCoins() — single catalogue reference from older exports', () => {
  it('turns catalogId / catalogNumber into catalogRefs and drops the old keys', () => {
    const old = { id: 'a', denomination: 'Denarius', catalogId: 1, catalogNumber: '6819' } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([old]);
    expect(coin.catalogRefs).toEqual([{ catalogId: 1, catalogNumber: '6819' }]);
    expect('catalogId' in coin).toBe(false);
    expect('catalogNumber' in coin).toBe(false);
  });

  it('keeps a catalogRefs list the file already has', () => {
    const current = { id: 'b', denomination: 'Denarius', catalogRefs: [{ catalogId: 2, catalogNumber: '1' }] } as unknown as CoinRecord;
    expect(normalizeImportedCoins([current])[0].catalogRefs).toEqual([{ catalogId: 2, catalogNumber: '1' }]);
  });

  it('adds nothing when the old pair had no number', () => {
    const old = { id: 'c', denomination: 'Denarius', catalogId: 1, catalogNumber: '' } as unknown as CoinRecord;
    expect(normalizeImportedCoins([old])[0].catalogRefs).toBeUndefined();
  });
});

describe('normalizeImportedCoins() — CAC needs a grade', () => {
  it('drops a CAC sticker from a coin with no grade', () => {
    const [coin] = normalizeImportedCoins([{ id: 'n', denomination: '$1', grade: '', hasCacSticker: true } as unknown as CoinRecord]);
    expect(coin.hasCacSticker).toBe(false);
  });

  it('keeps it on a graded coin', () => {
    const [coin] = normalizeImportedCoins([{ id: 'g', denomination: '$1', grade: 'MS64', hasCacSticker: true } as unknown as CoinRecord]);
    expect(coin.hasCacSticker).toBe(true);
  });
});
