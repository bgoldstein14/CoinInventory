/**
 * routes/data/index.ts — assembles the "everything that is not a coin" router.
 *
 * Mounted by server.ts as `app.use('/api', dataRouter)`:
 *
 *   transactions.ts  /api/transactions   purchase / sale history
 *   spot-prices.ts   /api/spot-prices    saved history + live futures fetch
 *   settings.ts      /api/settings/:key  AppSettings key/value store
 *   frontend-log.ts  /api/log            browser -> app.log logging sink
 *
 * These four groups have nothing to do with each other beyond "not coins",
 * which is why they are four files. Their path prefixes are all distinct, so
 * mount order cannot change which handler answers a request.
 */

import { Router } from 'express';
import transactionRoutes from './transactions';
import spotPriceRoutes from './spot-prices';
import settingsRoutes from './settings';
import frontendLogRoutes from './frontend-log';

const router = Router();

router.use(transactionRoutes);
router.use(spotPriceRoutes);
router.use(settingsRoutes);
router.use(frontendLogRoutes);

export default router;
