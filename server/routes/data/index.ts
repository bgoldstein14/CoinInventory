/**
 * routes/data/index.ts — assembles the "everything that is not a coin" router.
 *
 * Mounted by server.ts as `app.use('/api', dataRouter)`:
 *
 *   spot-prices.ts   /api/spot-prices    saved history + live futures fetch
 *   settings.ts      /api/settings/:key  AppSettings key/value store
 *   frontend-log.ts  /api/log            browser -> app.log logging sink
 *
 * These three groups have nothing to do with each other beyond "not coins",
 * which is why they are three files. Their path prefixes are all distinct, so
 * mount order cannot change which handler answers a request.
 *
 * THERE IS NO /api/transactions, AND THERE MUST NOT BE ONE AGAIN. The
 * Transactions table is gone and the buy / sale it recorded are now ordinary
 * columns on Coins, written by PUT /api/coins/:id like every other field.
 * Re-adding a router here would be a second write path to the same data.
 */

import { Router } from 'express';
import spotPriceRoutes from './spot-prices';
import settingsRoutes from './settings';
import frontendLogRoutes from './frontend-log';

const router = Router();

router.use(spotPriceRoutes);
router.use(settingsRoutes);
router.use(frontendLogRoutes);

export default router;
