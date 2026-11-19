/**
 * HTTP tests for creating, updating and deleting a coin (writes.ts) and the
 * transaction unwinding in write-helpers.ts, against the in-memory database.
 * Assertions read the stored rows. Statement text is asserted only where a row
 * can't show the bug: a column missing from a generated UPDATE, and an
 * expensive query that must not run.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  executedSql,
  executedQueries,
  insertCoin,
  queryRows,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { DbTransaction } from '../../db';
import { app } from '../../server';

/** A coin for the UPDATE paths to act on. */
async function existingCoin(id = 'abc-123'): Promise<string> {
  return insertCoin({ CoinId: id, Denomination: '$1', CoinType: 'Morgan', Year: '1921' });
}

/** The CoinImages rows of one coin, in display order. */
function imagesOf(coinId = 'abc-123'): Promise<Record<string, unknown>[]> {
  return queryRows(
    'SELECT ImageData, SortOrder, SourcePath FROM CoinImages WHERE CoinId = @coinId ORDER BY SortOrder',
    { coinId }
  );
}

/** The SourcePath of each of a coin's images, in display order. */
async function storedSourcePaths(coinId = 'abc-123'): Promise<unknown[]> {
  return (await imagesOf(coinId)).map((row) => row['SourcePath']);
}

/** Give a coin some photographs, with or without recorded originals. */
async function giveImages(
  coinId: string,
  images: Array<{ imageData: string; sourcePath: string | null }>
): Promise<void> {
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) ' +
        'VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
    );
    images.forEach((image, index) => {
      insert.run({
        coinId,
        imageData: image.imageData,
        sortOrder: index,
        sourcePath: image.sourcePath,
      });
    });
  });
}

describe('PUT /api/coins/:id parameter binding', () => {
  it('sends max-length Year, Grade and CoinSet values through without truncation', async () => {
    const longYear = 'Y'.repeat(50);
    const longGrade = 'G'.repeat(50);
    const longCoinSet = 'S'.repeat(100);

    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ year: longYear, grade: longGrade, coinSet: longCoinSet });

    expect(res.status).toBe(200);

    // The characters are actually stored.
    const [stored] = await queryRows('SELECT Year, Grade, CoinSet FROM Coins WHERE CoinId = @id', {
      id: 'abc-123',
    });
    expect(stored['Year']).toBe(longYear);
    expect(stored['Grade']).toBe(longGrade);
    expect(stored['CoinSet']).toBe(longCoinSet);

    // These declared widths are what db/bind-values.ts enforces.
    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('year')?.type).toMatchObject({ declared: 'NVARCHAR(50)' });
    expect(byName.get('grade')?.type).toMatchObject({ declared: 'NVARCHAR(50)' });
    expect(byName.get('coinSet')?.type).toMatchObject({ declared: 'NVARCHAR(100)' });
  });

  it('refuses a value one character past the declared width, rather than trimming it', async () => {
    // A 51st character is refused with a 400 (not truncated), and the stored
    // row is untouched.
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ grade: 'G'.repeat(51) });

    expect(res.status).toBe(400);
    const [stored] = await queryRows('SELECT Grade FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(stored['Grade']).toBeNull();
  });
});

describe('POST /api/coins', () => {
  it('returns 400 when denomination is missing', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ coinType: 'Washington' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('denomination');
    // The guard runs before any database work.
    expect(executedSql()).toEqual([]);
  });

  it('creates a coin and returns 201 with id', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'test-id',
        denomination: 'Quarter',
        coinType: 'Washington',
        year: '2024',
        imagePaths: ['data:image/png;base64,img1'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('test-id');

    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'test-id' });
    expect(coin['Denomination']).toBe('Quarter');
    expect(coin['CoinType']).toBe('Washington');
    expect(coin['Year']).toBe('2024');
    // The documented INSERT defaults.
    expect(coin['Source']).toBe('manual');
    expect(coin['HasCacSticker']).toBe(0);
    expect(coin['CollectionStatus']).toBe('owned');

    expect(await imagesOf('test-id')).toEqual([
      { ImageData: 'data:image/png;base64,img1', SortOrder: 0, SourcePath: null },
    ]);
  });

  it('ignores a stray tags key from an out-of-date client', async () => {
    // CoinTags was removed; an old client's `tags` key must be ignored.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-client-id',
        denomination: 'Quarter',
        tags: ['key-date'],
      });

    expect(res.status).toBe(201);
    for (const statement of executedSql()) {
      expect(statement).not.toContain('CoinTags');
    }
  });

  it('ignores a stray coin-level dealer key from an out-of-date client', async () => {
    // Coins.Dealer was dropped (migration 006); the key must be ignored.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-dealer-id',
        denomination: 'Quarter',
        dealer: 'Heritage',
      });

    expect(res.status).toBe(201);
    expect(capturedInputs().some((entry) => entry.name === 'dealer')).toBe(false);
    for (const statement of executedSql()) {
      // No Dealer column exists any more (PurchasedFrom / SoldTo replaced it).
      expect(statement).not.toContain('Dealer');
    }
  });

  it('refuses a second coin with the same id, and leaves the first one alone', async () => {
    // POST accepts a client id, so a replayed import must not overwrite a coin.
    await insertCoin({ CoinId: 'dup-id', Denomination: '$1', CoinType: 'Morgan' });

    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'dup-id', denomination: 'Quarter', coinType: 'Washington' });

    // 2627 -> 409.
    expect(res.status).toBe(409);

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'dup-id' });
    expect(coin['CoinType']).toBe('Morgan');
  });
});

// imagePaths and the SourcePath column
//
// Each element may be a bare base64 string or `{ imageData, sourcePath }`;
// the mixed-array test covers both together.

describe('imagePaths carries sourcePath through POST /api/coins', () => {
  it('accepts a mix of bare strings and { imageData, sourcePath } objects', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'mixed-id',
        denomination: 'Dollar',
        imagePaths: [
          // Legacy form: SourcePath NULL.
          'data:image/png;base64,legacy',
          // Object form.
          { imageData: 'data:image/png;base64,new', sourcePath: 'C:\\Coin Pictures\\b.jpg' },
        ],
      });

    expect(res.status).toBe(201);
    expect(await imagesOf('mixed-id')).toEqual([
      { ImageData: 'data:image/png;base64,legacy', SortOrder: 0, SourcePath: null },
      {
        ImageData: 'data:image/png;base64,new',
        SortOrder: 1,
        SourcePath: 'C:\\Coin Pictures\\b.jpg',
      },
    ]);
  });

  it('binds sourcePath as NVARCHAR(400), matching db/schema.sql', async () => {
    // A path at exactly the column length is stored untruncated.
    const maxLengthPath = 'C:\\' + 'p'.repeat(397);

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'maxpath-id',
        denomination: 'Dollar',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: maxLengthPath }],
      });

    expect(res.status).toBe(201);
    expect(await storedSourcePaths('maxpath-id')).toEqual([maxLengthPath]);

    const input = capturedInputs().find((entry) => entry.name === 'sourcePath');
    expect(input?.type).toMatchObject({ declared: 'NVARCHAR(400)', maxLength: 400 });
  });

  it('refuses a path past 400 characters rather than cutting it in half', async () => {
    // One character over is a 400, enforced by the binding layer.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'longpath-id',
        denomination: 'Dollar',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\' + 'p'.repeat(500) }],
      });

    expect(res.status).toBe(400);
    // The whole save is one transaction, so no coin is left behind.
    expect(await queryRows('SELECT CoinId FROM Coins WHERE CoinId = @id', { id: 'longpath-id' })).toEqual([]);
  });

  it('keeps SortOrder gap-free when an entry carries nothing usable', async () => {
    // Entries with a path but no picture are now referenced photos and are
    // stored; only entries with neither are dropped.
    await request(app)
      .post('/api/coins')
      .send({
        id: 'gaps-id',
        denomination: 'Dollar',
        imagePaths: [
          'data:image/png;base64,a',
          '',                        // dropped by the normalizer
          { imageData: '' },         // dropped: no picture and no path
          null,                      // dropped
          'data:image/png;base64,b',
        ],
      });

    const rows = await imagesOf('gaps-id');
    expect(rows.map((row) => row['SortOrder'])).toEqual([0, 1]);
    expect(rows.map((row) => row['ImageData'])).toEqual([
      'data:image/png;base64,a',
      'data:image/png;base64,b',
    ]);
  });

  it('writes a REFERENCED photograph as a path with no picture', async () => {
    // Referenced mode: SourcePath stored, ImageData NULL, SortOrder gap-free.
    await request(app)
      .post('/api/coins')
      .send({
        id: 'ref-id',
        denomination: 'Dollar',
        imagePaths: [
          { sourcePath: 'C:\\pics\\front.jpg' },
          '/api/images/file?path=' + encodeURIComponent('C:\\pics\\back.jpg'),
        ],
      });

    const rows = await imagesOf('ref-id');
    expect(rows.map((row) => row['SortOrder'])).toEqual([0, 1]);
    expect(rows.map((row) => row['ImageData'])).toEqual([null, null]);
    expect(rows.map((row) => row['SourcePath'])).toEqual([
      'C:\\pics\\front.jpg',
      'C:\\pics\\back.jpg',
    ]);
  });
});

describe('imagePaths replacement on PUT /api/coins/:id', () => {
  it('still replaces the whole set, now writing SourcePath too', async () => {
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,old', sourcePath: 'C:\\pics\\old.png' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.png' }],
      });

    expect(res.status).toBe(200);
    // Replacement: the old row is gone, only the new one remains.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,a', SortOrder: 0, SourcePath: 'C:\\pics\\a.png' },
    ]);
  });

  it('does not touch the images when imagePaths is absent from the body', async () => {
    // A PUT without imagePaths leaves every photo alone.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,keep', sourcePath: 'C:\\pics\\keep.png' },
    ]);

    await request(app).put('/api/coins/abc-123').send({ coinType: 'Morgan' });

    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,keep', SortOrder: 0, SourcePath: 'C:\\pics\\keep.png' },
    ]);
    expect(executedSql().some((statement) => statement.includes('CoinImages'))).toBe(false);
  });
});

// SourcePath preservation across the PUT delete/re-insert
//
// PUT with `imagePaths` deletes all CoinImages rows and re-inserts the array.
// Bare base64 entries carry no path, so without preservation every other
// photo's recorded original location would be erased. The server reads the
// existing (ImageData -> SourcePath) pairs in the same transaction, before the
// DELETE, and carries them onto entries without a path.
describe('PUT /api/coins/:id preserves SourcePath across the image replacement', () => {
  it('carries a stored SourcePath forward when the entry comes back as a bare string', async () => {
    // One recorded photo, re-sent as a bare string.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    expect(res.status).toBe(200);
    // Without preservation this would be [null].
    expect(await storedSourcePaths()).toEqual(['C:\\Coin Pictures\\alpha.jpg']);
  });

  it('carries it forward when the entry arrives as { imageData, sourcePath: null }', async () => {
    // The shipped client sends explicit `sourcePath: null` for unknown entries
    // once any entry has a path, so null must mean "unknown", not "clear".
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\Coin Pictures\\beta.jpg' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,alpha', sourcePath: null },
          { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\Coin Pictures\\beta.jpg' },
        ],
      });

    expect(res.status).toBe(200);
    expect(await storedSourcePaths()).toEqual([
      'C:\\Coin Pictures\\alpha.jpg',
      'C:\\Coin Pictures\\beta.jpg',
    ]);
  });

  it('lets an explicitly supplied path win over the stored one', async () => {
    // A supplied path wins. The second, unpathed entry forces the preservation
    // read (it is skipped when every entry has a path), so precedence is
    // actually exercised.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\old\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\pics\\beta.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,alpha', sourcePath: 'D:\\new\\alpha.jpg' },
          'data:image/png;base64,beta',
        ],
      });

    expect(await storedSourcePaths()).toEqual(['D:\\new\\alpha.jpg', 'C:\\pics\\beta.jpg']);
  });

  it('leaves an image with no stored and no supplied path as NULL', async () => {
    // Unknown stays unknown; no borrowing another image's path.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: ['data:image/png;base64,alpha', 'data:image/png;base64,brand-new'],
      });

    expect(await storedSourcePaths()).toEqual(['C:\\pics\\alpha.jpg', null]);
  });

  it('survives a photo being deleted and the rest re-ordered', async () => {
    // Reorder and delete both re-send the full array as bare strings.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\pics\\beta.jpg' },
      { imageData: 'data:image/png;base64,gamma', sourcePath: 'C:\\pics\\gamma.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,gamma', 'data:image/png;base64,alpha'] });

    // Matched by image data, so each keeps its own path in its new position.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,gamma', SortOrder: 0, SourcePath: 'C:\\pics\\gamma.jpg' },
      { ImageData: 'data:image/png;base64,alpha', SortOrder: 1, SourcePath: 'C:\\pics\\alpha.jpg' },
    ]);
    // Beta really is gone.
    expect((await imagesOf()).length).toBe(2);
  });

  it('reads the existing paths BEFORE the DELETE, inside the same transaction', async () => {
    // The read must come before the DELETE and inside the transaction.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    const readIndex = executedQueries.findIndex((event) =>
      event.sql.includes('ImageData, SourcePath FROM CoinImages')
    );
    const deleteIndex = executedQueries.findIndex((event) =>
      event.sql.includes('DELETE FROM CoinImages')
    );

    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeLessThan(deleteIndex);

    // Both inside the transaction (recorded per statement); the existence
    // check is outside by design.
    expect(executedQueries[readIndex].inTransaction).toBe(true);
    expect(executedQueries[deleteIndex].inTransaction).toBe(true);
    expect(executedQueries[0].sql).toContain('SELECT CoinId FROM Coins');
    expect(executedQueries[0].inTransaction).toBe(false);

    // Committed: the row survives.
    expect(await storedSourcePaths()).toEqual(['C:\\pics\\alpha.jpg']);
  });

  it('gives every copy of a duplicated image the first stored path', async () => {
    // Duplicate images are indistinguishable; lowest SortOrder's path wins for all.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,dup', sourcePath: 'C:\\pics\\first.jpg' },
      { imageData: 'data:image/png;base64,dup', sourcePath: 'C:\\pics\\second.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,dup', 'data:image/png;base64,dup'] });

    expect(await storedSourcePaths()).toEqual(['C:\\pics\\first.jpg', 'C:\\pics\\first.jpg']);
  });

  it('skips the preservation read when every entry already supplies a path', async () => {
    // The blob read must not run when there's no gap to fill (asserted on
    // statement text, since a query that doesn't run leaves no row).
    await existingCoin();

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.jpg' },
          { imageData: 'data:image/png;base64,b', sourcePath: 'C:\\pics\\b.jpg' },
        ],
      });

    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
  });

  it('skips the preservation read when imagePaths is empty (clearing all photos)', async () => {
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app).put('/api/coins/abc-123').send({ imagePaths: [] });

    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
    // An empty array means "delete them all".
    expect(await imagesOf()).toEqual([]);
  });

  it('does not run a preservation read on POST /api/coins', async () => {
    // Create has nothing to preserve.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'fresh-id',
        denomination: 'Dollar',
        imagePaths: ['data:image/png;base64,a'],
      });

    expect(res.status).toBe(201);
    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(false);
  });
});

describe('PUT /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    const res = await request(app)
      .put('/api/coins/nonexistent')
      .send({ coinType: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates a coin and returns 200', async () => {
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', denomination: '$1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('abc-123');

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Updated Morgan');
  });

  it('updates only the supplied fields so partial edits do not blank unrelated data', async () => {
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: '$1',
      CoinType: 'Morgan',
      Year: '1921',
      Notes: 'Nice toning',
    });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan' });

    // A column missing from the statement leaves nothing to read, so assert the text.
    const sqlText = executedSql().at(-1) as string;
    expect(sqlText).toContain('CoinType = @coinType');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Year = @year');

    // ...and everything else is still there.
    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Updated Morgan');
    expect(coin['Denomination']).toBe('$1');
    expect(coin['Year']).toBe('1921');
    expect(coin['Notes']).toBe('Nice toning');
  });

  /*
   * Purchase/sale fields on Coins. The key property: Notes and
   * TransactionNotes stay separate columns.
   */
  it('writes the purchase and sale counterparties and the deal note', async () => {
    await existingCoin();

    const res = await request(app).put('/api/coins/abc-123').send({
      purchasedFrom: 'Heritage',
      purchasePrice: 412.35,
      purchaseDate: '2019-04-02',
      soldTo: 'Stacks',
      soldPrice: 500,
      soldDate: '2024-06-15',
      transactionNotes: 'Paid in two instalments.',
    });
    expect(res.status).toBe(200);

    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['PurchasedFrom']).toBe('Heritage');
    expect(coin['PurchasePrice']).toBe(412.35);
    expect(coin['PurchaseDate']).toBe('2019-04-02');
    expect(coin['SoldTo']).toBe('Stacks');
    expect(coin['SoldPrice']).toBe(500);
    expect(coin['SoldDate']).toBe('2024-06-15');
    expect(coin['TransactionNotes']).toBe('Paid in two instalments.');
  });

  it('keeps the deal note and the coin note in separate columns', async () => {
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1', Notes: 'Lovely cartwheel lustre' });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ transactionNotes: "18% buyer's premium" });

    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    // The coin's own note is untouched by a write to the deal note.
    expect(coin['Notes']).toBe('Lovely cartwheel lustre');
    expect(coin['TransactionNotes']).toBe("18% buyer's premium");

    // And the other way round.
    await request(app).put('/api/coins/abc-123').send({ notes: 'Rim nick at 4 o clock' });

    const [after] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(after['Notes']).toBe('Rim nick at 4 o clock');
    expect(after['TransactionNotes']).toBe("18% buyer's premium");
  });

  it('ignores a stray tags key and still writes the real fields normally', async () => {
    // A body with a real field and a leftover `tags` key updates only the
    // field, with no DELETE against the removed CoinTags table.
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', tags: ['key-date'] });

    expect(res.status).toBe(200);

    const sqlText = executedSql().at(-1) as string;
    expect(sqlText).toContain('CoinType = @coinType');

    for (const statement of executedSql()) {
      expect(statement).not.toContain('CoinTags');
    }
  });
});

describe('DELETE /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    const res = await request(app).delete('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a coin and returns 204', async () => {
    await existingCoin();

    const res = await request(app).delete('/api/coins/abc-123');
    expect(res.status).toBe(204);
    expect(await queryRows('SELECT CoinId FROM Coins WHERE CoinId = @id', { id: 'abc-123' })).toEqual([]);
  });

  it('takes the coin\'s photographs with it', async () => {
    // Images go via ON DELETE CASCADE (foreign keys are enforced).
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,a', sourcePath: null },
    ]);

    expect(await request(app).delete('/api/coins/abc-123')).toMatchObject({ status: 204 });

    expect(await imagesOf()).toEqual([]);
  });
});

// Transaction rollback safety

describe('transaction rollback', () => {
  it('rolls the whole save back when one statement in it fails', async () => {
    // The UPDATE succeeds, then the image replacement fails on an over-long
    // SourcePath; the coin's type must not stay changed.
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1', CoinType: 'Morgan' });
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,keep', sourcePath: 'C:\\pics\\keep.png' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        coinType: 'Changed',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\' + 'p'.repeat(500) }],
      });

    expect(res.status).toBe(400);

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Morgan');
    // The image DELETE is undone too.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,keep', SortOrder: 0, SourcePath: 'C:\\pics\\keep.png' },
    ]);
  });

  it('reports the ORIGINAL error even when rollback() itself throws', async () => {
    // safeRollback() must report the original error even when rollback()
    // throws. The stub rolls back properly (releasing the lock), then again,
    // which produces the real "No transaction is active." error.
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1', CoinType: 'Morgan' });

    const realRollback = DbTransaction.prototype.rollback;
    const spy = vi
      .spyOn(DbTransaction.prototype, 'rollback')
      .mockImplementation(async function (this: DbTransaction) {
        await realRollback.call(this);
        // The transaction is finished, so this throws for real.
        await realRollback.call(this);
      });

    try {
      // An unresolvable foreign key (FK_CoinCatalogRefs_Catalog): a genuine 547.
      const res = await request(app)
        .put('/api/coins/abc-123')
        .send({ coinType: 'Peace', catalogRefs: [{ catalogId: 999999, catalogNumber: '1' }] });

      expect(spy).toHaveBeenCalled();
      // 547 -> 409. Had the rollback error replaced it, this would be a 500.
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }

    // Nothing left behind, and the next request works (the lock didn't leak).
    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', {
      id: 'abc-123',
    });
    expect(coin['CoinType']).toBe('Morgan');
    expect(await queryRows("SELECT RefId FROM CoinCatalogRefs WHERE CoinId = 'abc-123'")).toEqual([]);
  });
});
