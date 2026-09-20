/**
 * routes/data/index.ts — assembles the "everything that is not a coin" router.
 *
 * server.ts still does `app.use('/api', dataRouter)`, so every URL is exactly
 * what it always was:
 *
 *   transactions.ts  /api/transactions   purchase / sale history
 *   spot-prices.ts   /api/spot-prices    saved history + live metals.live fetch
 *   settings.ts      /api/settings/:key  AppSettings key/value store
 *   frontend-log.ts  /api/log            browser -> app.log logging sink
 *
 * These four groups have nothing to do with each other beyond "not coins",
 * which is precisely why they are now four files instead of one. Their path
 * prefixes are all distinct, so mount order cannot change which handler
 * answers a request; the order below matches the order they appeared in when
 * they shared a file.
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
