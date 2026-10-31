/**
 * routes/lookups/index.ts — assembles the reference-table ("lookup") router.
 *
 * server.ts still does `app.use('/api', lookupsRouter)`, so every URL is
 * exactly what it always was. These are the small tables that fill the
 * dropdowns in the coin edit form:
 *
 *   categories.ts      /api/categories      plain name list
 *   metal-contents.ts  /api/metalcontents   plain name list, read-only
 *   coin-sets.ts       /api/coin-sets       plain name list
 *   denominations.ts   /api/denominations   id + country + sort order, soft delete
 *   mint-marks.ts      /api/mintmarks       id + description,        soft delete
 *
 * All five paths are distinct literal prefixes, so mount order cannot change
 * which handler answers a request; the order below simply matches the order
 * these sections appeared in when they shared one file.
 */

import { Router } from 'express';
import categoryRoutes from './categories';
import metalContentRoutes from './metal-contents';
import coinSetRoutes from './coin-sets';
import denominationRoutes from './denominations';
import mintMarkRoutes from './mint-marks';

const router = Router();

router.use(categoryRoutes);
router.use(metalContentRoutes);
router.use(coinSetRoutes);
router.use(denominationRoutes);
router.use(mintMarkRoutes);

export default router;
