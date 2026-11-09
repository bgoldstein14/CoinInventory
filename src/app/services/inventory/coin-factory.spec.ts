/**
 * Tests for the coin factory — and specifically for the ONE thing that was at
 * risk when the "tags" feature was deleted: old backups must still import.
 *
 * ---- BACKGROUND ----
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
import { SEED_DENOMINATIONS, seedDenomination } from '../../testing/seed-denominations.fixture';

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
    /* A wrong-typed `imagePaths` is now REMOVED rather than replaced with
     * `[]`, and the difference is a data-safety one.
     *
     * `[]` is not a neutral default for this field: it is a positive claim
     * that the coin has no photographs, and the gallery turns that claim
     * into a `PUT` that DELETES the ones it does have (the array is sent
     * complete and the server re-inserts exactly what it is given). Absent
     * means "not loaded", which is what we actually know here, and the
     * hydrator fetches the real set when the coin is opened.
     *
     * This matters for ordinary imports, not just corrupt files: the JSON
     * export no longer contains photographs at all. */
    expect('imagePaths' in coin).toBe(false);
    expect(coin.source).toBe('manual');        // defaulted
    expect(coin.grade).toBe('');               // null -> empty string
    expect(coin.category).toBe('');
    expect(coin.hasCacSticker).toBe(false);
  });

  it('keeps a real imagePaths array, including a deliberately empty one', () => {
    // An export taken while photographs were still inlined carries the key.
    // `[]` there is a FACT about the coin and must survive — the opposite
    // mistake from the one above, and just as wrong if we got it backwards.
    const withPhotos = { id: 'a', imagePaths: ['data:image/jpeg;base64,AAA'] } as CoinRecord;
    const withoutPhotos = { id: 'b', imagePaths: [] } as unknown as CoinRecord;

    const [a, b] = normalizeImportedCoins([withPhotos, withoutPhotos]);

    expect(a.imagePaths).toEqual(['data:image/jpeg;base64,AAA']);
    expect('imagePaths' in b).toBe(true);
    expect(b.imagePaths).toEqual([]);
  });

  it('leaves imagePaths off entirely for a modern export, which has none', () => {
     /*
     * The normal case now. `GET /api/coins` stopped sending photographs
     * (server/routes/coins/list-query.ts), so the JSON export — which is
     * `JSON.stringify(inventory())` — has no `imagePaths` on any coin.
     *
     * Importing such a backup must not tell the app that the user's whole
     * collection has lost its pictures.
      */
    const modernExport = { id: 'a', coinType: 'Morgan', imageCount: 4 } as unknown as CoinRecord;

    const [coin] = normalizeImportedCoins([modernExport]);

    expect('imagePaths' in coin).toBe(false);
  });
});

 /*
 * Collection status and storage location on a freshly created / imported coin
 *
 * Same hazard as the `tags` story above, seen from the other direction. There
 * the risk was an old backup carrying a field the app no longer has; here it
 * is an old backup MISSING a field the app now has. Every JSON export the
 * owner has ever taken is in that category, and the field in question decides
 * whether a coin counts towards the value of his collection.
 *
 * A backup that restored as a collection of coins the app thinks he does not
 * own would be a catastrophe, and a quiet one: the coins would all be there,
 * in the grid, looking normal, with the totals reading nonsense.
  */

describe('collection status on a new coin', () => {
  it('starts Owned, explicitly', () => {
    // Not left undefined. The record is POSTed to the server as-is and is the
    // snapshot later edits are diffed against, so every field is spelled out.
    expect(createBlankCoin().collectionStatus).toBe('owned');
  });

  it('starts with an empty storage location rather than undefined', () => {
    expect(createBlankCoin().storageLocation).toBe('');
  });
});

describe('collection status when importing a JSON backup', () => {
  it('makes a coin with no status Owned', () => {
    // EVERY coin in EVERY backup taken before this feature shipped.
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
    // A hand-edited file, or one written by a newer build. Dropping the coin
    // out of the collection over a word we do not know is the wrong trade.
    const odd = { id: 'x-1', denomination: '$1', collectionStatus: 'on-loan' } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([odd]);

    expect(coin.collectionStatus).toBe('owned');
  });

  it('leaves a storage location exactly as the file had it', () => {
    // Free text. Nothing normalises it, nothing validates it, and a backup
    // with none simply has none -- unlike status, an absent storage location
    // is genuinely absent rather than a default in disguise.
    const stored = {
      id: 's-1', denomination: '$1', storageLocation: 'Dansco 7070, page 4'
    } as unknown as CoinRecord;
    const [coin] = normalizeImportedCoins([stored]);

    expect(coin.storageLocation).toBe('Dansco 7070, page 4');
  });
});

 /*
 * THE DENOMINATION LINK ON A JSON RESTORE                    (design §4.1)
 *
 * A JSON backup is the third import path, and it has the same obligation as
 * the QIF and spreadsheet ones: write the text the file gave, and link it to
 * a Denominations row where one can be established.
 *
 * It also has one obligation the others do not. A backup can ALREADY carry a
 * `denominationId`, because it was exported from a database that had one. An
 * id in the file is the user's own saved answer and outranks anything a
 * resolver works out; re-resolving it would silently re-file coins on every
 * restore, which is the opposite of what a restore is for.
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
    // Three issuers struck a Penny and the United States is not one of them.
    expect(coins[1].denominationId).toBeNull();
  });

  it('NEVER overwrites an id the backup already carried', () => {
    // The user's saved answer. Even when it disagrees with what the text
    // would resolve to -- which is the normal post-import state, text
    // saying 'Pillar Dollar' and id saying '8 Reales'.
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
    // Every existing caller passes one argument. A restore that happens
    // before the lookup has loaded must still restore.
    const file = [{ id: 'j-1', denomination: '$1', country: 'United States' }];
    const [coin] = normalizeImportedCoins(file as unknown as CoinRecord[]);

    expect(coin.denomination).toBe('$1');
    expect(coin.denominationId).toBeNull();
  });
});

describe('createBlankCoin() and the denomination link', () => {
  it('starts with no link, because it starts with no denomination', () => {
    // Spelled out rather than left undefined: the record is POSTed as-is
    // and is the snapshot later edits diff against.
    expect(createBlankCoin().denominationId).toBeNull();
  });
});
