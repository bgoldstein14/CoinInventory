/**
 * db/catalog-columns.spec.ts — the two catalogue columns on their way in and
 * out of the database.
 *
 * WHY THESE TWO COLUMNS NEED A SPEC OF THEIR OWN
 * `CatalogId` is the first INT FOREIGN KEY this application binds on the
 * Coins table. Every other column here is text, a decimal or a bit, and the
 * generic machinery around them — `normalizeNullable`, which turns an empty
 * value into SQL NULL — is right for all of them. It is NOT right for this
 * one, and the reason is specific:
 *
 *   The CSV importer copies a mapped cell into the record VERBATIM, as a
 *   string. So a coin that has been through Export -> CSV -> Import carries
 *   `catalogId: "3"`, not `catalogId: 3`. Bound straight through, that is a
 *   string arriving at an INT parameter — which the driver may coerce, may
 *   reject, or may turn into a confusing 8114 ("Error converting data type")
 *   depending on the value. A cell holding "Sear" (a header the user mapped
 *   onto the wrong field) would certainly fail, and it would fail at the
 *   point of SAVE, long after the import looked successful.
 *
 * So `catalogId` gets a normalizer that answers an integer or NULL and
 * nothing else. These tests pin that, and the usual schema-drift checks that
 * db/coin-fields.spec.ts applies to the text columns.
 *
 * The round-trip test matters for a plainer reason: a field the API accepts
 * but does not return is a field that silently empties itself the next time
 * the grid reloads.
 *
 * *** WHAT THE MOVE TO SQLITE CHANGED HERE. ***
 *
 * 1. The schema is read out of db/schema.sql now, not setup-database.sql,
 *    and through test-support/schema-columns.ts rather than a regex local to
 *    this file. SQLite cannot be told `NVARCHAR(50)` — the declared width
 *    lives in a trailing `-- NVARCHAR(50)` comment, which is what that module
 *    parses.
 *
 * 2. *** THE DECLARED LENGTH IN COIN_FIELDS IS NOW THE ONLY THING ENFORCING
 *    THE WIDTH. *** SQLite will store four thousand characters in a column
 *    this file calls NVARCHAR(50) without a murmur; db/bind-values.ts refuses
 *    it, using exactly the maxLength asserted below. A drift between the
 *    binding and db/schema.sql is therefore no longer a disagreement that the
 *    engine settles — it is a hole, and this spec is the only thing standing
 *    in it.
 *
 * 3. The last describe block is new and is the point of the whole migration:
 *    it PUTs the two fields at the real Express app, backed by a real
 *    in-memory database, and then SELECTs the row back to prove the values
 *    landed. The mssql mock could only ever show that some SQL was generated.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { findQuery, insertCoin, queryRows } from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { COIN_FIELDS, normalizeCoinValue, rowToCoin } from './index';
import { app } from '../server';

const schemaColumns = parseTable('Coins');

describe('COIN_FIELDS knows both catalogue columns', () => {
  it('parsed the Coins DDL, so the assertions below are not vacuous', () => {
    // parseTable() throws rather than returning an empty map, so this is a
    // belt-and-braces check that it found a real table and not one column.
    expect(schemaColumns.size).toBeGreaterThan(20);
    expect(schemaColumns.has('CoinId')).toBe(true);
  });

  it('binds CatalogId to the CatalogId column', () => {
    expect(COIN_FIELDS['catalogId'].column).toBe('CatalogId');
    // INT, so no maxLength — db/coin-fields.spec.ts only length-checks
    // NVARCHAR bindings, and declaring one here would be meaningless.
    expect(COIN_FIELDS['catalogId'].maxLength).toBeUndefined();
    expect(COIN_FIELDS['catalogId'].sqlType).toMatchObject({ storage: 'int', declared: 'INT' });
    // SQLite stores it as INTEGER; the `-- INT` comment is the declared type.
    expect(schemaColumns.get('CatalogId')).toMatchObject({
      storage: 'INTEGER',
      declared: 'INT',
      notNull: false,
    });
  });

  it('binds CatalogNumber at exactly NVARCHAR(50)', () => {
    // Shorter than the column silently truncates the user's reference.
    // Longer is no longer a disagreement the engine settles: SQLite enforces
    // nothing, so this number IS the limit — db/bind-values.ts raises the
    // 8152 equivalent (HTTP 400) at exactly the width declared here.
    expect(COIN_FIELDS['catalogNumber'].column).toBe('CatalogNumber');
    expect(COIN_FIELDS['catalogNumber'].maxLength).toBe(50);
    expect(COIN_FIELDS['catalogNumber'].sqlType).toMatchObject({
      storage: 'text',
      maxLength: 50,
      declared: 'NVARCHAR(50)',
    });
    expect(schemaColumns.get('CatalogNumber')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(50)',
      maxLength: 50,
      notNull: false,
    });
  });

  it('gives neither column an insert default', () => {
    // A default would attribute every coin created by a client that has
    // never heard of this feature to a catalogue nobody chose.
    expect(COIN_FIELDS['catalogId'].insertDefault).toBeUndefined();
    expect(COIN_FIELDS['catalogNumber'].insertDefault).toBeUndefined();
  });
});

describe('normalizing catalogId on the way in', () => {
  it('passes a real id straight through', () => {
    expect(normalizeCoinValue('catalogId', 3)).toBe(3);
  });

  it('turns the STRING form a CSV round-trip produces into a number', () => {
    // The whole reason this normalizer exists. See the header.
    expect(normalizeCoinValue('catalogId', '3')).toBe(3);
    expect(normalizeCoinValue('catalogId', ' 3 ')).toBe(3);
  });

  it('turns "no catalogue" into SQL NULL, in all of its spellings', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(normalizeCoinValue('catalogId', empty)).toBeNull();
    }
  });

  it('refuses text that is not a number, rather than letting the driver fail', () => {
    // "Sear" gets here when a user maps a catalogue-NAME column onto this
    // field on the import screen. NULL loses the attribution, which is
    // recoverable; a failed INSERT loses the whole coin, which is not.
    expect(normalizeCoinValue('catalogId', 'Sear')).toBeNull();
    expect(normalizeCoinValue('catalogId', 'KM# 110')).toBeNull();
    expect(normalizeCoinValue('catalogId', Number.NaN)).toBeNull();
  });

  it('truncates nothing and rounds nothing on a legitimate id', () => {
    expect(normalizeCoinValue('catalogId', 15)).toBe(15);
    expect(normalizeCoinValue('catalogId', '15')).toBe(15);
  });
});

describe('normalizing catalogNumber on the way in', () => {
  it('has NO normalizer, deliberately', () => {
    // The plainest entry in COIN_FIELDS, exactly like `variety` and
    // `storageLocation` beside it. Anything this app did to the text --
    // upper-casing it, trimming it to a pattern, matching it against a
    // lookup -- would rewrite a key into a printed book. If a future change
    // gives this field a normalizer, the reason had better be written down.
    expect(COIN_FIELDS['catalogNumber'].normalize).toBeUndefined();
  });

  it('stores the reference exactly as the catalogues write it', () => {
    // No upper-casing, no stripping of dots or slashes, no collapsing of the
    // internal space. A reference the app tidied no longer matches the book.
    for (const reference of ['1A', '6819', 'II.1 234', 'RRC 44/5']) {
      expect(normalizeCoinValue('catalogNumber', reference)).toBe(reference);
    }
  });

  it('turns an absent field into SQL NULL', () => {
    expect(normalizeCoinValue('catalogNumber', undefined)).toBeNull();
    expect(normalizeCoinValue('catalogNumber', null)).toBeNull();
  });

  it('leaves an empty box as the empty string the client sent', () => {
    // This is the house behaviour of normalizeNullable (only `undefined`
    // becomes NULL), shared with certNumber, variety and storageLocation.
    // Pinned rather than "fixed": both spellings of empty read as "no
    // reference" everywhere above this layer -- formatCatalogReference()
    // trims and treats '' and null alike -- so changing it here would be a
    // behavioural difference between this column and its neighbours for no
    // user-visible gain.
    expect(normalizeCoinValue('catalogNumber', '')).toBe('');
  });
});

describe('reading both columns back out', () => {
  it('returns them to the Angular app under their camelCase names', () => {
    const coin = rowToCoin({
      CoinId: 'abc', CatalogId: 1, CatalogNumber: '6819'
    });
    expect(coin['catalogId']).toBe(1);
    expect(coin['catalogNumber']).toBe('6819');
  });

  it('omits them entirely for a coin that has no reference', () => {
    // `undefined`, not null and not 0: JSON.stringify drops the key, so the
    // client can tell "never recorded" from "recorded as blank" — the same
    // rule coinSet and storageLocation follow. A 0 here would be read as a
    // catalogue id by anything that checks truthiness the wrong way round.
    const coin = rowToCoin({ CoinId: 'abc', CatalogId: null, CatalogNumber: null });
    expect(coin['catalogId']).toBeUndefined();
    expect(coin['catalogNumber']).toBeUndefined();
  });

  it('survives a row from a database the migration has not reached', () => {
    // Until 012 has been run the columns do not exist, so the row has no
    // such keys at all. That must read as "no reference", not as a crash.
    const coin = rowToCoin({ CoinId: 'abc' });
    expect(coin['catalogId']).toBeUndefined();
    expect(coin['catalogNumber']).toBeUndefined();
  });
});

/**
 * *** THE BLOCK THE MOCK COULD NOT WRITE. ***
 *
 * `PUT /api/coins/:id` generates its UPDATE from the keys present in the
 * request body INTERSECTED WITH COIN_FIELDS. A column missing from that map
 * yields a statement that never names it, a 200 response, and a value that is
 * gone on the next reload — no error anywhere in that sequence. The old spec
 * could only check the generated SQL text. Now the row itself can be read
 * back, which is the assertion that actually matches the bug.
 *
 * Both are kept: the SQL text says the statement NAMES the column, the SELECT
 * says the value LANDED. The first fails more legibly, the second cannot be
 * satisfied by a statement that happens to compile.
 */
describe('the catalogue columns over HTTP, written and read back', () => {
  it('PUT /api/coins/:id names both columns and the values land in the row', async () => {
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm' });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ catalogId: 3, catalogNumber: 'RRC 44/5' });

    expect(res.status).toBe(200);

    const update = findQuery(/^UPDATE Coins SET/);
    expect(update?.sql).toContain('CatalogId = @catalogId');
    expect(update?.sql).toContain('CatalogNumber = @catalogNumber');

    const [row] = await queryRows('SELECT CatalogId, CatalogNumber FROM Coins WHERE CoinId = @id', {
      id: 'abc-123',
    });
    expect(row['CatalogId']).toBe(3);
    expect(row['CatalogNumber']).toBe('RRC 44/5');
  });

  it('stores a CSV-round-tripped string id as a real INTEGER, not as text', async () => {
    // The normalizer unit test above proves the conversion; this proves the
    // converted value is what SQLite ends up holding. SQLite is dynamically
    // typed, so a string that slipped through would be stored AS A STRING in
    // an INTEGER column and would then fail to match `WHERE CatalogId = 3`.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm' });

    await request(app).put('/api/coins/abc-123').send({ catalogId: '3' });

    const [row] = await queryRows(
      "SELECT CatalogId, typeof(CatalogId) AS StoredType FROM Coins WHERE CoinId = 'abc-123'"
    );
    expect(row['CatalogId']).toBe(3);
    expect(row['StoredType']).toBe('integer');
  });

  it('clears the attribution rather than losing the coin when a NAME arrives', async () => {
    // The import-mapping accident, end to end. The link goes to NULL and the
    // save still succeeds; the user sees an unattributed coin and fixes it in
    // one click, instead of losing the record to a failed statement.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm', CatalogId: 3 });

    const res = await request(app).put('/api/coins/abc-123').send({ catalogId: 'Sear' });

    expect(res.status).toBe(200);
    const [row] = await queryRows("SELECT CatalogId FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['CatalogId']).toBeNull();
  });

  it('refuses a catalogue number past the declared width instead of truncating it', async () => {
    // *** NOTHING BUT COIN_FIELDS STOPS THIS NOW. *** SQL Server raised 8152
    // on a 51st character; SQLite would have stored all 4,000 of them. The
    // declared NVARCHAR(50) asserted at the top of this file is what
    // db/bind-values.ts enforces, and this is the proof it is enforced rather
    // than merely written down. 50 is accepted untouched, 51 is a 400 — a
    // refused value can be retyped, a truncated one cannot be recovered.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm' });

    const atLimit = 'N'.repeat(50);
    const overLimit = 'N'.repeat(51);

    const accepted = await request(app)
      .put('/api/coins/abc-123')
      .send({ catalogNumber: atLimit });
    expect(accepted.status).toBe(200);

    const [stored] = await queryRows("SELECT CatalogNumber FROM Coins WHERE CoinId = 'abc-123'");
    expect(stored['CatalogNumber']).toBe(atLimit);

    const refused = await request(app)
      .put('/api/coins/abc-123')
      .send({ catalogNumber: overLimit });
    expect(refused.status).toBe(400);

    // And the refusal left the previous value alone rather than half-writing.
    const [after] = await queryRows("SELECT CatalogNumber FROM Coins WHERE CoinId = 'abc-123'");
    expect(after['CatalogNumber']).toBe(atLimit);
  });

  it('refuses a catalogue id that names no catalogue — the foreign key is real', async () => {
    // FK_Coins_Catalog exists in db/schema.sql and PRAGMA foreign_keys is on
    // for every connection (db/driver.ts), so an id that passes the
    // normalizer but matches no row is rejected by the database itself. The
    // mssql mock had no constraints at all and would have reported success.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm' });

    const res = await request(app).put('/api/coins/abc-123').send({ catalogId: 999999 });

    expect(res.status).toBe(409);
    const [row] = await queryRows("SELECT CatalogId FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['CatalogId']).toBeNull();
  });

  it('hands both columns back out of GET /api/coins/:id', async () => {
    // The reload the header warns about: a field the API accepts but does not
    // return empties itself the next time the grid loads. Proved here against
    // a row that really went through the database, rather than against a
    // hand-built object handed to rowToCoin().
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Tetradrachm',
      CatalogId: 1,
      CatalogNumber: '6819',
    });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body.catalogId).toBe(1);
    expect(res.body.catalogNumber).toBe('6819');
  });

  it('seeds the catalogue the attributions point at', async () => {
    // Guards the tests above from passing vacuously: an attribution to
    // catalogue 3 would also "work" against an empty Catalogs table if the
    // foreign key were not enforced, and the 409 above would then be the
    // only thing distinguishing the two situations.
    const catalogs = await queryRows('SELECT Name FROM Catalogs ORDER BY CatalogId');
    expect(catalogs.length).toBeGreaterThanOrEqual(15);
    expect(catalogs[0]['Name']).toBe('Sear');
  });
});
