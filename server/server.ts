import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import sql from 'mssql';
import path from 'path';
import crypto from 'crypto';

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

function buildDbConfig(): sql.config {
  const user = process.env['DB_USER'];
  const password = process.env['DB_PASSWORD'];
  const useWindowsAuth = !user;

  const config: sql.config = {
    server: process.env['DB_SERVER'] ?? '192.168.0.10\\SQLEXPRESS',
    port: parseInt(process.env['DB_PORT'] ?? '1433', 10),
    database: process.env['DB_NAME'] ?? 'CoinInventory',
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  };

  if (useWindowsAuth) {
    config.driver = 'msnodesqlv8';
    (config.options as Record<string, unknown>)['trustedConnection'] = true;
  } else {
    config.user = user;
    config.password = password;
  }

  return config;
}

// ============================================================
// Database pool (lazy singleton)
// ============================================================

let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool) {
    pool = await sql.connect(buildDbConfig());
    console.log('Connected to SQL Server');
  }
  return pool;
}

// ============================================================
// Express app
// ============================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const angularDistPath = path.resolve(__dirname, '..', 'dist', 'coin-inventory-app', 'browser');
app.use(express.static(angularDistPath));

// ============================================================
// Helpers
// ============================================================

function rowToCoin(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row['id'],
    name: row['name'],
    denomination: row['denomination'] ?? '',
    year: row['year'] ?? null,
    type: row['type'] ?? '',
    category: row['category'] ?? '',
    country: row['country'] ?? '',
    grade: row['grade'] ?? '',
    certCompany: row['cert_company'] ?? '',
    certNumber: row['cert_number'] ?? '',
    variety: row['variety'] ?? '',
    mintMark: row['mint_mark'] ?? '',
    composition: row['composition'] ?? '',
    purchaseDate: row['purchase_date'] ? formatDate(row['purchase_date'] as Date) : '',
    purchasePrice: row['purchase_price'] ?? 0,
    currentValue: row['current_value'] ?? 0,
    notes: row['notes'] ?? '',
    source: row['source'] ?? 'manual',
    hasCacSticker: row['has_cac_sticker'] === true || row['has_cac_sticker'] === 1,
    soldPrice: row['sold_price'] ?? undefined,
    soldDate: row['sold_date'] ? formatDate(row['sold_date'] as Date) : undefined,
    dealer: row['dealer'] ?? undefined,
    weight: row['weight'] ?? undefined,
    metalContent: row['metal_content'] ?? undefined,
    coinSet: row['coin_set'] ?? undefined,
  };
}

function formatDate(d: Date | string): string {
  if (typeof d === 'string') return d;
  return d.toISOString().slice(0, 10);
}

// ============================================================
// Coins API
// ============================================================

app.get('/api/coins', async (_req: Request, res: Response) => {
  try {
    const db = await getPool();

    const coinsResult = await db.request().query('SELECT * FROM coins ORDER BY name');
    const imagesResult = await db.request().query('SELECT * FROM coin_images ORDER BY sort_order');
    const tagsResult = await db.request().query('SELECT * FROM coin_tags ORDER BY tag');

    const imagesByCoinId = new Map<string, string[]>();
    for (const img of imagesResult.recordset) {
      const coinId = img['coin_id'] as string;
      if (!imagesByCoinId.has(coinId)) imagesByCoinId.set(coinId, []);
      imagesByCoinId.get(coinId)!.push(img['image_data'] as string);
    }

    const tagsByCoinId = new Map<string, string[]>();
    for (const t of tagsResult.recordset) {
      const coinId = t['coin_id'] as string;
      if (!tagsByCoinId.has(coinId)) tagsByCoinId.set(coinId, []);
      tagsByCoinId.get(coinId)!.push(t['tag'] as string);
    }

    const coins = coinsResult.recordset.map((row) => ({
      ...rowToCoin(row),
      imagePaths: imagesByCoinId.get(row['id'] as string) ?? [],
      tags: tagsByCoinId.get(row['id'] as string) ?? [],
    }));

    res.json(coins);
  } catch (err) {
    console.error('GET /api/coins error:', err);
    res.status(500).json({ error: 'Failed to retrieve coins' });
  }
});

app.get('/api/coins/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;

    const coinResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM coins WHERE id = @id');

    if (coinResult.recordset.length === 0) {
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const imagesResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM coin_images WHERE coin_id = @id ORDER BY sort_order');

    const tagsResult = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT * FROM coin_tags WHERE coin_id = @id ORDER BY tag');

    const coin = {
      ...rowToCoin(coinResult.recordset[0]),
      imagePaths: imagesResult.recordset.map((r) => r['image_data'] as string),
      tags: tagsResult.recordset.map((r) => r['tag'] as string),
    };

    res.json(coin);
  } catch (err) {
    console.error('GET /api/coins/:id error:', err);
    res.status(500).json({ error: 'Failed to retrieve coin' });
  }
});

app.post('/api/coins', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const body = req.body;
    const id = body.id || crypto.randomUUID();

    if (!body.name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const transaction = new sql.Transaction(db);
    await transaction.begin();

    try {
      await new sql.Request(transaction)
        .input('id', sql.NVarChar(36), id)
        .input('name', sql.NVarChar(255), body.name)
        .input('denomination', sql.NVarChar(100), body.denomination ?? null)
        .input('year', sql.Int, body.year ?? null)
        .input('type', sql.NVarChar(100), body.type ?? null)
        .input('category', sql.NVarChar(100), body.category ?? null)
        .input('country', sql.NVarChar(100), body.country ?? null)
        .input('grade', sql.NVarChar(20), body.grade ?? null)
        .input('cert_company', sql.NVarChar(50), body.certCompany ?? null)
        .input('cert_number', sql.NVarChar(100), body.certNumber ?? null)
        .input('variety', sql.NVarChar(100), body.variety ?? null)
        .input('mint_mark', sql.NVarChar(10), body.mintMark ?? null)
        .input('composition', sql.NVarChar(100), body.composition ?? null)
        .input('purchase_date', sql.Date, body.purchaseDate || null)
        .input('purchase_price', sql.Decimal(12, 2), body.purchasePrice ?? null)
        .input('current_value', sql.Decimal(12, 2), body.currentValue ?? null)
        .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
        .input('source', sql.NVarChar(20), body.source ?? 'manual')
        .input('has_cac_sticker', sql.Bit, body.hasCacSticker ? 1 : 0)
        .input('sold_price', sql.Decimal(12, 2), body.soldPrice ?? null)
        .input('sold_date', sql.Date, body.soldDate || null)
        .input('dealer', sql.NVarChar(255), body.dealer ?? null)
        .input('weight', sql.Decimal(10, 4), body.weight ?? null)
        .input('metal_content', sql.NVarChar(50), body.metalContent ?? null)
        .input('coin_set', sql.NVarChar(255), body.coinSet ?? null)
        .query(`
          INSERT INTO coins
            (id, name, denomination, year, type, category, country, grade,
             cert_company, cert_number, variety, mint_mark, composition,
             purchase_date, purchase_price, current_value, notes, source,
             has_cac_sticker, sold_price, sold_date, dealer, weight,
             metal_content, coin_set)
          VALUES
            (@id, @name, @denomination, @year, @type, @category, @country, @grade,
             @cert_company, @cert_number, @variety, @mint_mark, @composition,
             @purchase_date, @purchase_price, @current_value, @notes, @source,
             @has_cac_sticker, @sold_price, @sold_date, @dealer, @weight,
             @metal_content, @coin_set)
        `);

      const images: string[] = body.imagePaths ?? [];
      for (let i = 0; i < images.length; i++) {
        await new sql.Request(transaction)
          .input('coin_id', sql.NVarChar(36), id)
          .input('image_data', sql.NVarChar(sql.MAX), images[i])
          .input('sort_order', sql.Int, i)
          .query('INSERT INTO coin_images (coin_id, image_data, sort_order) VALUES (@coin_id, @image_data, @sort_order)');
      }

      const tags: string[] = body.tags ?? [];
      for (const tag of tags) {
        await new sql.Request(transaction)
          .input('coin_id', sql.NVarChar(36), id)
          .input('tag', sql.NVarChar(100), tag)
          .query('INSERT INTO coin_tags (coin_id, tag) VALUES (@coin_id, @tag)');
      }

      await transaction.commit();
      res.status(201).json({ id });
    } catch (innerErr) {
      await transaction.rollback();
      throw innerErr;
    }
  } catch (err) {
    console.error('POST /api/coins error:', err);
    res.status(500).json({ error: 'Failed to create coin' });
  }
});

app.put('/api/coins/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    const body = req.body;

    const existing = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT id FROM coins WHERE id = @id');

    if (existing.recordset.length === 0) {
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const transaction = new sql.Transaction(db);
    await transaction.begin();

    try {
      await new sql.Request(transaction)
        .input('id', sql.NVarChar(36), id)
        .input('name', sql.NVarChar(255), body.name)
        .input('denomination', sql.NVarChar(100), body.denomination ?? null)
        .input('year', sql.Int, body.year ?? null)
        .input('type', sql.NVarChar(100), body.type ?? null)
        .input('category', sql.NVarChar(100), body.category ?? null)
        .input('country', sql.NVarChar(100), body.country ?? null)
        .input('grade', sql.NVarChar(20), body.grade ?? null)
        .input('cert_company', sql.NVarChar(50), body.certCompany ?? null)
        .input('cert_number', sql.NVarChar(100), body.certNumber ?? null)
        .input('variety', sql.NVarChar(100), body.variety ?? null)
        .input('mint_mark', sql.NVarChar(10), body.mintMark ?? null)
        .input('composition', sql.NVarChar(100), body.composition ?? null)
        .input('purchase_date', sql.Date, body.purchaseDate || null)
        .input('purchase_price', sql.Decimal(12, 2), body.purchasePrice ?? null)
        .input('current_value', sql.Decimal(12, 2), body.currentValue ?? null)
        .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
        .input('source', sql.NVarChar(20), body.source ?? 'manual')
        .input('has_cac_sticker', sql.Bit, body.hasCacSticker ? 1 : 0)
        .input('sold_price', sql.Decimal(12, 2), body.soldPrice ?? null)
        .input('sold_date', sql.Date, body.soldDate || null)
        .input('dealer', sql.NVarChar(255), body.dealer ?? null)
        .input('weight', sql.Decimal(10, 4), body.weight ?? null)
        .input('metal_content', sql.NVarChar(50), body.metalContent ?? null)
        .input('coin_set', sql.NVarChar(255), body.coinSet ?? null)
        .query(`
          UPDATE coins SET
            name = @name, denomination = @denomination, year = @year,
            type = @type, category = @category, country = @country,
            grade = @grade, cert_company = @cert_company, cert_number = @cert_number,
            variety = @variety, mint_mark = @mint_mark, composition = @composition,
            purchase_date = @purchase_date, purchase_price = @purchase_price,
            current_value = @current_value, notes = @notes, source = @source,
            has_cac_sticker = @has_cac_sticker, sold_price = @sold_price,
            sold_date = @sold_date, dealer = @dealer, weight = @weight,
            metal_content = @metal_content, coin_set = @coin_set
          WHERE id = @id
        `);

      if (body.imagePaths !== undefined) {
        await new sql.Request(transaction)
          .input('coin_id', sql.NVarChar(36), id)
          .query('DELETE FROM coin_images WHERE coin_id = @coin_id');

        const images: string[] = body.imagePaths ?? [];
        for (let i = 0; i < images.length; i++) {
          await new sql.Request(transaction)
            .input('coin_id', sql.NVarChar(36), id)
            .input('image_data', sql.NVarChar(sql.MAX), images[i])
            .input('sort_order', sql.Int, i)
            .query('INSERT INTO coin_images (coin_id, image_data, sort_order) VALUES (@coin_id, @image_data, @sort_order)');
        }
      }

      if (body.tags !== undefined) {
        await new sql.Request(transaction)
          .input('coin_id', sql.NVarChar(36), id)
          .query('DELETE FROM coin_tags WHERE coin_id = @coin_id');

        const tags: string[] = body.tags ?? [];
        for (const tag of tags) {
          await new sql.Request(transaction)
            .input('coin_id', sql.NVarChar(36), id)
            .input('tag', sql.NVarChar(100), tag)
            .query('INSERT INTO coin_tags (coin_id, tag) VALUES (@coin_id, @tag)');
        }
      }

      await transaction.commit();
      res.json({ id });
    } catch (innerErr) {
      await transaction.rollback();
      throw innerErr;
    }
  } catch (err) {
    console.error('PUT /api/coins/:id error:', err);
    res.status(500).json({ error: 'Failed to update coin' });
  }
});

app.delete('/api/coins/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;

    const result = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('DELETE FROM coins WHERE id = @id');

    if (result.rowsAffected[0] === 0) {
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/coins/:id error:', err);
    res.status(500).json({ error: 'Failed to delete coin' });
  }
});

// ============================================================
// Coin Images API
// ============================================================

app.post('/api/coins/:id/images', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;

    const coin = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('SELECT id FROM coins WHERE id = @id');

    if (coin.recordset.length === 0) {
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    const maxOrder = await db.request()
      .input('coin_id', sql.NVarChar(36), id)
      .query('SELECT ISNULL(MAX(sort_order), -1) AS max_order FROM coin_images WHERE coin_id = @coin_id');

    let nextOrder = (maxOrder.recordset[0]['max_order'] as number) + 1;

    const images: string[] = Array.isArray(req.body.images)
      ? req.body.images
      : [req.body.image ?? req.body.imageData];

    const insertedIds: number[] = [];
    for (const imageData of images) {
      if (!imageData) continue;
      const result = await db.request()
        .input('coin_id', sql.NVarChar(36), id)
        .input('image_data', sql.NVarChar(sql.MAX), imageData)
        .input('sort_order', sql.Int, nextOrder++)
        .query('INSERT INTO coin_images (coin_id, image_data, sort_order) OUTPUT INSERTED.id VALUES (@coin_id, @image_data, @sort_order)');
      insertedIds.push(result.recordset[0]['id'] as number);
    }

    res.status(201).json({ imageIds: insertedIds });
  } catch (err) {
    console.error('POST /api/coins/:id/images error:', err);
    res.status(500).json({ error: 'Failed to add image(s)' });
  }
});

app.delete('/api/coins/:id/images/:imageId', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id, imageId } = req.params;

    const result = await db.request()
      .input('id', sql.Int, parseInt(imageId, 10))
      .input('coin_id', sql.NVarChar(36), id)
      .query('DELETE FROM coin_images WHERE id = @id AND coin_id = @coin_id');

    if (result.rowsAffected[0] === 0) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/coins/:id/images/:imageId error:', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// ============================================================
// Categories API
// ============================================================

app.get('/api/categories', async (_req: Request, res: Response) => {
  try {
    const db = await getPool();
    const result = await db.request().query('SELECT name FROM categories ORDER BY name');
    res.json(result.recordset.map((r) => r['name'] as string));
  } catch (err) {
    console.error('GET /api/categories error:', err);
    res.status(500).json({ error: 'Failed to retrieve categories' });
  }
});

app.post('/api/categories', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    await db.request()
      .input('name', sql.NVarChar(100), name.trim())
      .query(`
        IF NOT EXISTS (SELECT 1 FROM categories WHERE name = @name)
          INSERT INTO categories (name) VALUES (@name)
      `);

    res.status(201).json({ name: name.trim() });
  } catch (err) {
    console.error('POST /api/categories error:', err);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

app.delete('/api/categories/:name', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.params;

    const result = await db.request()
      .input('name', sql.NVarChar(100), name)
      .query('DELETE FROM categories WHERE name = @name');

    if (result.rowsAffected[0] === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/categories/:name error:', err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ============================================================
// Coin Sets API
// ============================================================

app.get('/api/coin-sets', async (_req: Request, res: Response) => {
  try {
    const db = await getPool();
    const result = await db.request().query('SELECT name FROM coin_sets ORDER BY name');
    res.json(result.recordset.map((r) => r['name'] as string));
  } catch (err) {
    console.error('GET /api/coin-sets error:', err);
    res.status(500).json({ error: 'Failed to retrieve coin sets' });
  }
});

app.post('/api/coin-sets', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    await db.request()
      .input('name', sql.NVarChar(255), name.trim())
      .query(`
        IF NOT EXISTS (SELECT 1 FROM coin_sets WHERE name = @name)
          INSERT INTO coin_sets (name) VALUES (@name)
      `);

    res.status(201).json({ name: name.trim() });
  } catch (err) {
    console.error('POST /api/coin-sets error:', err);
    res.status(500).json({ error: 'Failed to add coin set' });
  }
});

app.delete('/api/coin-sets/:name', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.params;

    const result = await db.request()
      .input('name', sql.NVarChar(255), name)
      .query('DELETE FROM coin_sets WHERE name = @name');

    if (result.rowsAffected[0] === 0) {
      res.status(404).json({ error: 'Coin set not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/coin-sets/:name error:', err);
    res.status(500).json({ error: 'Failed to delete coin set' });
  }
});

// ============================================================
// Transactions API
// ============================================================

app.get('/api/transactions', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const coinId = req.query['coinId'] as string | undefined;

    let query = 'SELECT * FROM transactions';
    const request = db.request();

    if (coinId) {
      query += ' WHERE coin_id = @coinId';
      request.input('coinId', sql.NVarChar(36), coinId);
    }

    query += ' ORDER BY date DESC';
    const result = await request.query(query);

    const transactions = result.recordset.map((row) => ({
      id: row['id'],
      coinId: row['coin_id'],
      type: row['type'],
      date: formatDate(row['date'] as Date),
      amount: row['amount'],
      dealer: row['dealer'] ?? '',
      notes: row['notes'] ?? '',
    }));

    res.json(transactions);
  } catch (err) {
    console.error('GET /api/transactions error:', err);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

app.post('/api/transactions', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const body = req.body;
    const id = body.id || crypto.randomUUID();

    if (!body.coinId || !body.type || !body.date) {
      res.status(400).json({ error: 'coinId, type, and date are required' });
      return;
    }

    await db.request()
      .input('id', sql.NVarChar(36), id)
      .input('coin_id', sql.NVarChar(36), body.coinId)
      .input('type', sql.NVarChar(20), body.type)
      .input('date', sql.Date, body.date)
      .input('amount', sql.Decimal(12, 2), body.amount ?? 0)
      .input('dealer', sql.NVarChar(255), body.dealer ?? null)
      .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
      .query(`
        INSERT INTO transactions (id, coin_id, type, date, amount, dealer, notes)
        VALUES (@id, @coin_id, @type, @date, @amount, @dealer, @notes)
      `);

    res.status(201).json({ id });
  } catch (err) {
    console.error('POST /api/transactions error:', err);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

app.delete('/api/transactions/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;

    const result = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('DELETE FROM transactions WHERE id = @id');

    if (result.rowsAffected[0] === 0) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /api/transactions/:id error:', err);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// ============================================================
// Spot Prices API
// ============================================================

app.get('/api/spot-prices/latest', async (_req: Request, res: Response) => {
  try {
    const db = await getPool();
    const result = await db.request()
      .query('SELECT TOP 1 * FROM spot_prices ORDER BY fetched_at DESC');

    if (result.recordset.length === 0) {
      res.json({ gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null });
      return;
    }

    const row = result.recordset[0];
    res.json({
      gold: row['gold'],
      silver: row['silver'],
      platinum: row['platinum'],
      copper: row['copper'],
      source: row['source'],
      fetchedAt: row['fetched_at'],
    });
  } catch (err) {
    console.error('GET /api/spot-prices/latest error:', err);
    res.status(500).json({ error: 'Failed to retrieve spot prices' });
  }
});

app.post('/api/spot-prices', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { gold, silver, platinum, copper, source } = req.body;

    const result = await db.request()
      .input('gold', sql.Decimal(10, 2), gold ?? 0)
      .input('silver', sql.Decimal(10, 2), silver ?? 0)
      .input('platinum', sql.Decimal(10, 2), platinum ?? 0)
      .input('copper', sql.Decimal(10, 4), copper ?? 0)
      .input('source', sql.NVarChar(100), source ?? null)
      .query(`
        INSERT INTO spot_prices (gold, silver, platinum, copper, source)
        OUTPUT INSERTED.id, INSERTED.fetched_at
        VALUES (@gold, @silver, @platinum, @copper, @source)
      `);

    res.status(201).json({
      id: result.recordset[0]['id'],
      fetchedAt: result.recordset[0]['fetched_at'],
    });
  } catch (err) {
    console.error('POST /api/spot-prices error:', err);
    res.status(500).json({ error: 'Failed to save spot prices' });
  }
});

// ============================================================
// Settings API
// ============================================================

app.get('/api/settings/:key', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { key } = req.params;

    const result = await db.request()
      .input('key', sql.NVarChar(100), key)
      .query('SELECT setting_value FROM app_settings WHERE setting_key = @key');

    if (result.recordset.length === 0) {
      res.status(404).json({ error: 'Setting not found' });
      return;
    }

    const raw = result.recordset[0]['setting_value'] as string;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }

    res.json({ key, value });
  } catch (err) {
    console.error('GET /api/settings/:key error:', err);
    res.status(500).json({ error: 'Failed to retrieve setting' });
  }
});

app.put('/api/settings/:key', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { key } = req.params;
    const { value } = req.body;

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    await db.request()
      .input('key', sql.NVarChar(100), key)
      .input('value', sql.NVarChar(sql.MAX), serialized)
      .query(`
        MERGE app_settings AS target
        USING (SELECT @key AS setting_key) AS source
        ON target.setting_key = source.setting_key
        WHEN MATCHED THEN UPDATE SET setting_value = @value
        WHEN NOT MATCHED THEN INSERT (setting_key, setting_value) VALUES (@key, @value);
      `);

    res.json({ key, value });
  } catch (err) {
    console.error('PUT /api/settings/:key error:', err);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// ============================================================
// Angular SPA fallback -- must be LAST
// ============================================================
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(angularDistPath, 'index.html'));
});

// ============================================================
// Global error handler
// ============================================================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// Export for testing
// ============================================================
export { app, getPool };

// ============================================================
// Start (only when run directly)
// ============================================================
const isMainModule = require.main === module || process.argv[1]?.endsWith('server.ts');
if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`Coin Inventory server listening on http://localhost:${PORT}`);
    console.log(`Database: ${process.env['DB_SERVER'] ?? '192.168.0.10\\SQLEXPRESS'} / ${process.env['DB_NAME'] ?? 'CoinInventory'}`);
  });
}
