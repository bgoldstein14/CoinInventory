/**
 * Catalogue references: the CoinCatalogRefs table and the `catalogRefs` list
 * on the coin API (create, replace, clear, read back, cascade, widths).
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import { insertCoin, queryRows } from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { COIN_FIELDS, SCHEMA_VERSION } from './index';
import { app } from '../server';

describe('CoinCatalogRefs schema', () => {
  it('declares the table with the expected columns and widths', () => {
    const columns = parseTable('CoinCatalogRefs');
    expect([...columns.keys()]).toEqual(['RefId', 'CoinId', 'CatalogId', 'CatalogNumber', 'SortOrder']);
    expect(columns.get('CatalogNumber')).toMatchObject({ declared: 'NVARCHAR(50)', maxLength: 50, notNull: true });
    expect(columns.get('CatalogId')).toMatchObject({ declared: 'INT', notNull: false });
  });

  it('cascades from Coins and links to Catalogs without cascading', async () => {
    const fks = await queryRows("SELECT * FROM pragma_foreign_key_list('CoinCatalogRefs')");
    const toCoins = fks.find(fk => fk['table'] === 'Coins');
    const toCatalogs = fks.find(fk => fk['table'] === 'Catalogs');
    expect(toCoins?.['on_delete']).toBe('CASCADE');
    expect(toCatalogs?.['on_delete']).toBe('NO ACTION');
  });

  it('indexes refs by coin (in order) and by catalogue', async () => {
    const indexes = await queryRows("SELECT name FROM pragma_index_list('CoinCatalogRefs')");
    const names = indexes.map(i => i['name']);
    expect(names).toContain('IX_CoinCatalogRefs_CoinId_SortOrder');
    expect(names).toContain('IX_CoinCatalogRefs_CatalogId');
  });

  it('no longer has the single-reference columns on Coins', async () => {
    const columns = await queryRows("SELECT name FROM pragma_table_info('Coins')");
    const names = columns.map(c => c['name']);
    expect(names).not.toContain('CatalogId');
    expect(names).not.toContain('CatalogNumber');
    expect(COIN_FIELDS['catalogId']).toBeUndefined();
    expect(COIN_FIELDS['catalogNumber']).toBeUndefined();
  });

  it('stamps schema version 2', async () => {
    expect(SCHEMA_VERSION).toBe(2);
    const [row] = await queryRows('PRAGMA user_version');
    expect(row['user_version']).toBe(2);
  });
});

const REFS = [
  { catalogId: 2, catalogNumber: '123' },
  { catalogId: 1, catalogNumber: '6819' },
  { catalogId: null, catalogNumber: 'Cohen 45' }
];

async function refsInDb(coinId: string) {
  return queryRows(
    'SELECT CatalogId, CatalogNumber, SortOrder FROM CoinCatalogRefs WHERE CoinId = @id ORDER BY SortOrder',
    { id: coinId }
  );
}

describe('catalogRefs over HTTP', () => {
  it('POST stores the list in order and GET returns it', async () => {
    const created = await request(app).post('/api/coins').send({ id: 'c-1', denomination: 'Denarius', catalogRefs: REFS });
    expect(created.status).toBe(201);

    const rows = await refsInDb('c-1');
    expect(rows.map(r => [r['CatalogId'], r['CatalogNumber'], r['SortOrder']])).toEqual([
      [2, '123', 0], [1, '6819', 1], [null, 'Cohen 45', 2]
    ]);

    const one = await request(app).get('/api/coins/c-1');
    expect(one.body.catalogRefs).toEqual(REFS);

    const list = await request(app).get('/api/coins');
    expect(list.body.find((c: { id: string }) => c.id === 'c-1').catalogRefs).toEqual(REFS);
  });

  it('PUT with catalogRefs replaces the list', async () => {
    await request(app).post('/api/coins').send({ id: 'c-2', denomination: 'Denarius', catalogRefs: REFS });
    await request(app).put('/api/coins/c-2').send({ catalogRefs: [{ catalogId: 3, catalogNumber: '736' }] });
    expect((await refsInDb('c-2')).map(r => r['CatalogNumber'])).toEqual(['736']);
  });

  it('PUT without catalogRefs leaves the list alone', async () => {
    await request(app).post('/api/coins').send({ id: 'c-3', denomination: 'Denarius', catalogRefs: REFS });
    await request(app).put('/api/coins/c-3').send({ coinType: 'Tiberius' });
    expect(await refsInDb('c-3')).toHaveLength(3);
  });

  it('PUT with an empty list clears every reference', async () => {
    await request(app).post('/api/coins').send({ id: 'c-4', denomination: 'Denarius', catalogRefs: REFS });
    await request(app).put('/api/coins/c-4').send({ catalogRefs: [] });
    expect(await refsInDb('c-4')).toHaveLength(0);
    expect((await request(app).get('/api/coins/c-4')).body.catalogRefs).toEqual([]);
  });

  it('saves a duplicate reference once and drops references without a number', async () => {
    await request(app).post('/api/coins').send({
      id: 'c-5', denomination: 'Denarius',
      catalogRefs: [
        { catalogId: 1, catalogNumber: ' 6819 ' },
        { catalogId: 1, catalogNumber: '6819' },
        { catalogId: 2, catalogNumber: '' }
      ]
    });
    const rows = await refsInDb('c-5');
    expect(rows.map(r => [r['CatalogId'], r['CatalogNumber']])).toEqual([[1, '6819']]);
  });

  it('stores a string id from a CSV round trip as an integer, and a name as no catalogue', async () => {
    await request(app).post('/api/coins').send({
      id: 'c-6', denomination: 'Denarius',
      catalogRefs: [{ catalogId: '3', catalogNumber: '1' }, { catalogId: 'Sear', catalogNumber: '2' }]
    });
    const rows = await queryRows(
      "SELECT CatalogId, typeof(CatalogId) AS T FROM CoinCatalogRefs WHERE CoinId = 'c-6' ORDER BY SortOrder"
    );
    expect(rows.map(r => [r['CatalogId'], r['T']])).toEqual([[3, 'integer'], [null, 'null']]);
  });

  it('refuses a number longer than 50 characters and writes nothing', async () => {
    await insertCoin({ CoinId: 'c-7', Denomination: 'Denarius' });
    const ok = await request(app).put('/api/coins/c-7').send({ catalogRefs: [{ catalogId: 1, catalogNumber: 'N'.repeat(50) }] });
    expect(ok.status).toBe(200);
    const refused = await request(app).put('/api/coins/c-7').send({ catalogRefs: [{ catalogId: 1, catalogNumber: 'N'.repeat(51) }] });
    expect(refused.status).toBe(400);
    expect((await refsInDb('c-7')).map(r => r['CatalogNumber'])).toEqual(['N'.repeat(50)]);
  });

  it('refuses a catalogue id that names no catalogue', async () => {
    await insertCoin({ CoinId: 'c-8', Denomination: 'Denarius' });
    const res = await request(app).put('/api/coins/c-8').send({ catalogRefs: [{ catalogId: 999999, catalogNumber: '1' }] });
    expect(res.status).toBe(409);
    expect(await refsInDb('c-8')).toHaveLength(0);
  });

  it('deletes a coin\'s references with the coin', async () => {
    await request(app).post('/api/coins').send({ id: 'c-9', denomination: 'Denarius', catalogRefs: REFS });
    await request(app).delete('/api/coins/c-9');
    expect(await refsInDb('c-9')).toHaveLength(0);
  });

  it('lists coins without references with an empty list', async () => {
    await insertCoin({ CoinId: 'c-10', Denomination: 'Denarius' });
    const list = await request(app).get('/api/coins');
    expect(list.body.find((c: { id: string }) => c.id === 'c-10').catalogRefs).toEqual([]);
  });

  it('has the seeded catalogues the tests point at', async () => {
    const catalogs = await queryRows('SELECT CatalogId, Name FROM Catalogs ORDER BY CatalogId');
    expect(catalogs.length).toBeGreaterThanOrEqual(15);
    expect(catalogs[0]).toMatchObject({ CatalogId: 1, Name: 'Sear' });
  });
});
