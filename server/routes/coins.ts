/**
 * Coins API routes — CRUD for coins plus image management.
 *
 * Coins are the core entity. Each coin can have multiple images (stored as
 * base64 in CoinImages table) and multiple tags (CoinTags table).
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import crypto from 'crypto';
import { logInfo, logWarn, logError } from '../logger';
import { getPool, rowToCoin } from '../db';

const router = Router();

// ============================================================
// GET /api/coins — all coins with images and tags joined
// ============================================================
router.get('/', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching all coins with images and tags');
    const db = await getPool();

    const coinsResult = await db.request().query('SELECT * FROM Coins ORDER BY Denomination, Year');
    const imagesResult = await db.request().query('SELECT * FROM CoinImages ORDER BY SortOrder');
    const tagsResult = await db.request().query('SELECT * FROM CoinTags ORDER BY Tag');

    // Build lookup maps for images and tags by CoinId
    const imagesByCoinId = new Map<string, string[]>();
    for (const img of imagesResult.recordset) {
      const coinId = img['CoinId'] as string;
      if (!imagesByCoinId.has(coinId)) imagesByCoinId.set(coinId, []);
      imagesByCoinId.get(coinId)!.push(img['ImageData'] as string);
    }

    const tagsByCoinId = new Map<string, string[]>();
    for (const t of tagsResult.recordset) {
      const coinId = t['CoinId'] as string;
      if (!tagsByCoinId.has(coinId)) tagsByCoinId.set(coinId, []);
      tagsByCoinId.get(coinId)!.push(t['Tag'] as string);
    }

    const coins = coinsResult.recordset.map((row) => ({
      ...rowToCoin(row),
      imagePaths: imagesByCoinId.get(row['CoinId'] as string) ?? [],
      tags: tagsByCoinId.get(row['CoinId'] as string) ?? [],
    }));

    logInfo(`Retrieved ${coins.length} coins`);
    res.json(coins);
  } catch (err) {
    logError('GET /api/coins error', err);
    res.status(500).json({ error: 'Failed to retrieve coins' });
  }
});

// ============================================================
// GET /api/coins/:id — single coin with images and tags
// ============================================================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Fetching coin ${id}`);

    const coinResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM Coins WHERE CoinId = @id');

    if (coinResult.recordset.length === 0) {
      logWarn(`Coin not found: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const imagesResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

    const tagsResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM CoinTags WHERE CoinId = @id ORDER BY Tag');

    const coin = {
      ...rowToCoin(coinResult.recordset[0]),
      imagePaths: imagesResult.recordset.map((r) => r['ImageData'] as string),
      tags: tagsResult.recordset.map((r) => r['Tag'] as string),
    };

    res.json(coin);
  } catch (err) {
    logError('GET /api/coins/:id error', err);
    res.status(500).json({ error: 'Failed to retrieve coin' });
  }
});

// ============================================================
// POST /api/coins — create a new coin with optional images/tags
// ============================================================
router.post('/', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const body = req.body;
    if (!body.denomination) {
      res.status(400).json({ error: 'denomination is required' });
      return;
    }

    const id = body.id || crypto.randomUUID();
    logInfo(`Creating new coin ${id}`);

    const transaction = new sql.Transaction(db);
    await transaction.begin();

    try {
      await new sql.Request(transaction)
        .input('id', sql.NVarChar(36), id)
        .input('denomination', sql.NVarChar(100), body.denomination ?? null)
        .input('year', sql.NVarChar(10), body.year ?? null)
        .input('coinType', sql.NVarChar(100), body.coinType ?? null)
        .input('category', sql.NVarChar(100), body.category ?? null)
        .input('country', sql.NVarChar(100), body.country ?? null)
        .input('grade', sql.NVarChar(20), body.grade ?? null)
        .input('certCompany', sql.NVarChar(50), body.certCompany ?? null)
        .input('certNumber', sql.NVarChar(100), body.certNumber ?? null)
        .input('variety', sql.NVarChar(100), body.variety ?? null)
        .input('mintMark', sql.NVarChar(10), body.mintMark ?? null)
        .input('composition', sql.NVarChar(100), body.composition ?? null)
        .input('purchaseDate', sql.Date, body.purchaseDate || null)
        .input('purchasePrice', sql.Decimal(12, 2), body.purchasePrice ?? null)
        .input('currentValue', sql.Decimal(12, 2), body.currentValue ?? null)
        .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
        .input('source', sql.NVarChar(20), body.source ?? 'manual')
        .input('hasCacSticker', sql.Bit, body.hasCacSticker ? 1 : 0)
        .input('soldPrice', sql.Decimal(12, 2), body.soldPrice ?? null)
        .input('soldDate', sql.Date, body.soldDate || null)
        .input('dealer', sql.NVarChar(255), body.dealer ?? null)
        .input('weight', sql.Decimal(10, 4), body.weight ?? null)
        .input('metalContent', sql.NVarChar(50), body.metalContent ?? null)
        .input('pmWeightGrams', sql.Decimal(10, 4), body.pmWeightGrams ?? null)
        .input('pmPercent', sql.Decimal(5, 2), body.pmPercent ?? null)
        .input('coinSet', sql.NVarChar(255), body.coinSet ?? null)
        .query(`
          INSERT INTO Coins
            (CoinId, Denomination, Year, CoinType, Category, Country, Grade,
             CertCompany, CertNumber, Variety, MintMark, Composition,
             PurchaseDate, PurchasePrice, CurrentValue, Notes, Source,
             HasCacSticker, SoldPrice, SoldDate, Dealer, Weight,
             MetalContent, PmWeightGrams, PmPercent, CoinSet)
          VALUES
            (@id, @denomination, @year, @coinType, @category, @country, @grade,
             @certCompany, @certNumber, @variety, @mintMark, @composition,
             @purchaseDate, @purchasePrice, @currentValue, @notes, @source,
             @hasCacSticker, @soldPrice, @soldDate, @dealer, @weight,
             @metalContent, @pmWeightGrams, @pmPercent, @coinSet)
        `);

      const images: string[] = body.imagePaths ?? [];
      for (let i = 0; i < images.length; i++) {
        await new sql.Request(transaction)
          .input('coinId', sql.NVarChar(36), id)
          .input('imageData', sql.NVarChar(sql.MAX), images[i])
          .input('sortOrder', sql.Int, i)
          .query('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (@coinId, @imageData, @sortOrder)');
      }

      const tags: string[] = body.tags ?? [];
      for (const tag of tags) {
        await new sql.Request(transaction)
          .input('coinId', sql.NVarChar(36), id)
          .input('tag', sql.NVarChar(100), tag)
          .query('INSERT INTO CoinTags (CoinId, Tag) VALUES (@coinId, @tag)');
      }

      await transaction.commit();
      logInfo(`Coin ${id} created successfully`);
      res.status(201).json({ id });
    } catch (innerErr) {
      await transaction.rollback();
      throw innerErr;
    }
  } catch (err) {
    logError('POST /api/coins error', err);
    res.status(500).json({ error: 'Failed to create coin' });
  }
});

// ============================================================
// PUT /api/coins/:id — update an existing coin
// ============================================================
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    const body = req.body;
    logInfo(`Updating coin ${id}`);

    const existing = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

    if (existing.recordset.length === 0) {
      logWarn(`Coin not found for update: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const transaction = new sql.Transaction(db);
    await transaction.begin();

    try {
      await new sql.Request(transaction)
        .input('id', sql.NVarChar(36), id)
        .input('denomination', sql.NVarChar(100), body.denomination ?? null)
        .input('year', sql.NVarChar(10), body.year ?? null)
        .input('coinType', sql.NVarChar(100), body.coinType ?? null)
        .input('category', sql.NVarChar(100), body.category ?? null)
        .input('country', sql.NVarChar(100), body.country ?? null)
        .input('grade', sql.NVarChar(20), body.grade ?? null)
        .input('certCompany', sql.NVarChar(50), body.certCompany ?? null)
        .input('certNumber', sql.NVarChar(100), body.certNumber ?? null)
        .input('variety', sql.NVarChar(100), body.variety ?? null)
        .input('mintMark', sql.NVarChar(10), body.mintMark ?? null)
        .input('composition', sql.NVarChar(100), body.composition ?? null)
        .input('purchaseDate', sql.Date, body.purchaseDate || null)
        .input('purchasePrice', sql.Decimal(12, 2), body.purchasePrice ?? null)
        .input('currentValue', sql.Decimal(12, 2), body.currentValue ?? null)
        .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
        .input('source', sql.NVarChar(20), body.source ?? 'manual')
        .input('hasCacSticker', sql.Bit, body.hasCacSticker ? 1 : 0)
        .input('soldPrice', sql.Decimal(12, 2), body.soldPrice ?? null)
        .input('soldDate', sql.Date, body.soldDate || null)
        .input('dealer', sql.NVarChar(255), body.dealer ?? null)
        .input('weight', sql.Decimal(10, 4), body.weight ?? null)
        .input('metalContent', sql.NVarChar(50), body.metalContent ?? null)
        .input('pmWeightGrams', sql.Decimal(10, 4), body.pmWeightGrams ?? null)
        .input('pmPercent', sql.Decimal(5, 2), body.pmPercent ?? null)
        .input('coinSet', sql.NVarChar(255), body.coinSet ?? null)
        .query(`
          UPDATE Coins SET
            Denomination = @denomination, Year = @year,
            CoinType = @coinType, Category = @category, Country = @country,
            Grade = @grade, CertCompany = @certCompany, CertNumber = @certNumber,
            Variety = @variety, MintMark = @mintMark, Composition = @composition,
            PurchaseDate = @purchaseDate, PurchasePrice = @purchasePrice,
            CurrentValue = @currentValue, Notes = @notes, Source = @source,
            HasCacSticker = @hasCacSticker, SoldPrice = @soldPrice,
            SoldDate = @soldDate, Dealer = @dealer, Weight = @weight,
            MetalContent = @metalContent, PmWeightGrams = @pmWeightGrams,
            PmPercent = @pmPercent, CoinSet = @coinSet
          WHERE CoinId = @id
        `);

      // Replace images if provided
      if (body.imagePaths !== undefined) {
        await new sql.Request(transaction)
          .input('coinId', sql.NVarChar(36), id)
          .query('DELETE FROM CoinImages WHERE CoinId = @coinId');

        const images: string[] = body.imagePaths ?? [];
        for (let i = 0; i < images.length; i++) {
          await new sql.Request(transaction)
            .input('coinId', sql.NVarChar(36), id)
            .input('imageData', sql.NVarChar(sql.MAX), images[i])
            .input('sortOrder', sql.Int, i)
            .query('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (@coinId, @imageData, @sortOrder)');
        }
      }

      // Replace tags if provided
      if (body.tags !== undefined) {
        await new sql.Request(transaction)
          .input('coinId', sql.NVarChar(36), id)
          .query('DELETE FROM CoinTags WHERE CoinId = @coinId');

        const tags: string[] = body.tags ?? [];
        for (const tag of tags) {
          await new sql.Request(transaction)
            .input('coinId', sql.NVarChar(36), id)
            .input('tag', sql.NVarChar(100), tag)
            .query('INSERT INTO CoinTags (CoinId, Tag) VALUES (@coinId, @tag)');
        }
      }

      await transaction.commit();
      logInfo(`Coin ${id} updated successfully`);
      res.json({ id });
    } catch (innerErr) {
      await transaction.rollback();
      throw innerErr;
    }
  } catch (err) {
    logError('PUT /api/coins/:id error', err);
    res.status(500).json({ error: 'Failed to update coin' });
  }
});

// ============================================================
// DELETE /api/coins/:id — deletes coin (images/tags cascade)
// ============================================================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Deleting coin ${id}`);

    const result = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('DELETE FROM Coins WHERE CoinId = @id');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Coin not found for deletion: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Coin ${id} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/coins/:id error', err);
    res.status(500).json({ error: 'Failed to delete coin' });
  }
});

// ============================================================
// POST /api/coins/:id/images — add images to a coin
// ============================================================
router.post('/:id/images', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Adding images to coin ${id}`);

    const coin = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

    if (coin.recordset.length === 0) {
      logWarn(`Coin not found for image add: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const maxOrder = await db.request()
      .input('coinId', sql.NVarChar(36), id)
      .query('SELECT ISNULL(MAX(SortOrder), -1) AS max_order FROM CoinImages WHERE CoinId = @coinId');

    let nextOrder = (maxOrder.recordset[0]['max_order'] as number) + 1;

    const images: string[] = Array.isArray(req.body.images)
      ? req.body.images
      : [req.body.image ?? req.body.imageData];

    const insertedIds: number[] = [];
    for (const imageData of images) {
      if (!imageData) continue;
      const result = await db.request()
        .input('coinId', sql.NVarChar(36), id)
        .input('imageData', sql.NVarChar(sql.MAX), imageData)
        .input('sortOrder', sql.Int, nextOrder++)
        .query('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) OUTPUT INSERTED.ImageId VALUES (@coinId, @imageData, @sortOrder)');
      insertedIds.push(result.recordset[0]['ImageId'] as number);
    }

    logInfo(`Added ${insertedIds.length} images to coin ${id}`);
    res.status(201).json({ imageIds: insertedIds });
  } catch (err) {
    logError('POST /api/coins/:id/images error', err);
    res.status(500).json({ error: 'Failed to add image(s)' });
  }
});

// ============================================================
// DELETE /api/coins/:id/images/:imageId — remove a specific image
// ============================================================
router.delete('/:id/images/:imageId', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id, imageId } = req.params;
    logInfo(`Deleting image ${imageId} from coin ${id}`);

    const result = await db.request()
      .input('id', sql.Int, parseInt(imageId, 10))
      .input('coinId', sql.NVarChar(36), id)
      .query('DELETE FROM CoinImages WHERE ImageId = @id AND CoinId = @coinId');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Image not found for deletion: ${imageId}`);
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    logInfo(`Image ${imageId} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/coins/:id/images/:imageId error', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

export default router;
