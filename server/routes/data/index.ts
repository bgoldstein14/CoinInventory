/**
 * The non-coin data router, mounted at /api by server.ts:
 *
 *   spot-prices.ts   /api/spot-prices    saved history + live futures fetch
 *   settings.ts      /api/settings/:key  AppSettings key/value store
 *   frontend-log.ts  /api/log            browser -> app.log
 *
 * Prefixes are distinct, so mount order doesn't matter. There is no
 * /api/transactions: purchase and sale are Coins columns, written by PUT
 * /api/coins/:id.
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
