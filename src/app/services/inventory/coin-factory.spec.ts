/**
 * Tests for the coin factory — and specifically for the ONE thing that was at
 * risk when the "tags" feature was deleted: old backups must still import.
 *
 * ---------------------------------------------------------------------------
 * BACKGROUND
 * ---------------------------------------------------------------------------
 * `CoinRecord` used to have a `tags: string[]` field, backed by a CoinTags
 * table and a "Tags" column in the grid. Nothing in the app could ever put a
 * value in it — there was no editor input, bulk edit did not offer it, and
 * neither importer could set one — so the column could only ever show a dash.
 * The whole feature was removed.
 *
 * But the user's own JSON exports, taken while the field existed, still carry
 * `"tags": [...]` on every coin. Those files are his backups. Opening one after
 * the upgrade must simply work: the key is ignored, not rejected, and certainly
 * not a crash. These tests pin that down so a future refactor of
 * `normalizeImportedCoins` (for instance one that validates against a strict
 * key list) cannot quietly break reading an old backup.
 */
import { describe, expect, it } from 'vitest';
import { createBlankCoin, normalizeImportedCoins } from './coin-factory';
import { CoinRecord } from '../../types/coin.model';

/**
 * A coin exactly as it appeared in a JSON export made BEFORE tags were removed.
 *
 * It is typed `Record<string, unknown>` and cast on the way in on purpose. That
 * is honest about the real situation: this object came out of `JSON.parse()` of
 * a file on disk, so TypeScript has never checked it and the compiler cannot
 * know whether `tags` is there. Writing it as a `CoinRecord` literal would not
 * even compile now that the field is gone — which is precisely why the runtime
 * behaviour needs a test of its own.
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
  // <-- the field that no longer exists. Populated, not just empty, because a
  //     populated array is the harder case: an empty one could be dropped by
  //     accident and nobody would notice.
  tags: ['key-date', 'rainbow toning'],
  source: 'manual',
  hasCacSticker: false,
};

describe('createBlankCoin()', () => {
  it('does not create a tags field', () => {
    // Belt and braces: if someone re-adds `tags: []` to the blank coin, it
    // would start being POSTed to a backend that no longer accepts it.
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
    // The cast models what really happens: parsed JSON is handed to the
    // normaliser as if it were a CoinRecord.
    const [coin] = normalizeImportedCoins([OLD_FORMAT_EXPORT as unknown as CoinRecord]);

    // No throw, and every field the app actually uses survived intact.
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
    // Several coins at once, which is the realistic shape of a backup file.
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
    // The closest thing to the real path: text off disk -> parse -> normalise.
    const fileText = JSON.stringify([OLD_FORMAT_EXPORT]);

    const coins = normalizeImportedCoins(JSON.parse(fileText) as CoinRecord[]);

    expect(coins).toHaveLength(1);
    expect(coins[0].coinType).toBe('Morgan');
  });

  it('still fills in the gaps it has always filled in', () => {
    // Guard the rest of the normaliser while we are here: removing tags must
    // not have disturbed the other repairs.
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
    expect(coin.imagePaths).toEqual([]);       // wrong type replaced
    expect(coin.source).toBe('manual');        // defaulted
    expect(coin.grade).toBe('');               // null -> empty string
    expect(coin.category).toBe('');
    expect(coin.hasCacSticker).toBe(false);
  });
});
