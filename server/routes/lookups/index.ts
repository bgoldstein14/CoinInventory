/**
 * The lookup router, mounted at /api by server.ts. These tables fill the coin
 * form's dropdowns:
 *
 *   categories.ts          /api/categories           plain name list
 *   metal-contents.ts      /api/metalcontents        plain name list, read-only
 *   coin-sets.ts           /api/coin-sets            plain name list
 *   issuers.ts             /api/issuers              soft delete
 *   denominations.ts       /api/denominations        soft delete
 *   mint-marks.ts          /api/mintmarks            soft delete
 *   catalogs.ts            /api/catalogs             soft delete
 *   reference-usage.ts     /api/reference-usage      coin counts per entry
 *   denomination-lookup.ts /api/denomination-lookup  Wikidata proposals (an
 *                                                    outbound request)
 *
 * All paths are distinct literal prefixes, so mount order doesn't matter.
 */

import { Router } from 'express';
import categoryRoutes from './categories';
import metalContentRoutes from './metal-contents';
import coinSetRoutes from './coin-sets';
import issuerRoutes from './issuers';
import denominationRoutes from './denominations';
import mintMarkRoutes from './mint-marks';
import catalogRoutes from './catalogs';
import referenceUsageRoutes from './reference-usage';
import denominationLookupRoutes from './denomination-lookup';

const router = Router();

router.use(categoryRoutes);
router.use(metalContentRoutes);
router.use(coinSetRoutes);
router.use(issuerRoutes);
router.use(denominationRoutes);
router.use(mintMarkRoutes);
router.use(catalogRoutes);
router.use(referenceUsageRoutes);
router.use(denominationLookupRoutes);

export default router;
