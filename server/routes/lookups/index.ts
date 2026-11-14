/**
 * routes/lookups/index.ts — assembles the reference-table ("lookup") router.
 *
 * Mounted by server.ts as `app.use('/api', lookupsRouter)`. These are the
 * small tables that fill the dropdowns in the coin edit form:
 *
 *   categories.ts      /api/categories      plain name list
 *   metal-contents.ts  /api/metalcontents   plain name list, read-only
 *   coin-sets.ts       /api/coin-sets       plain name list
 *   issuers.ts         /api/issuers         who struck the coin,     soft delete
 *   denominations.ts   /api/denominations   id + issuer + country,   soft delete
 *   mint-marks.ts      /api/mintmarks       id + description,        soft delete
 *   catalogs.ts        /api/catalogs        id + sort order,         soft delete
 *
 * ...plus one endpoint that is not a table:
 *
 *   reference-usage.ts /api/reference-usage how many coins use each entry of
 *                                           all five of the above. Read-only,
 *                                           and the number the maintenance
 *                                           screen shows before it offers to
 *                                           delete something.
 *
 * ...plus one endpoint that is not a table and not even a database read:
 *
 *   denomination-lookup.ts /api/denomination-lookup
 *                                           asks Wikidata what denominations
 *                                           an issuer struck, so a newly
 *                                           added issuer does not start
 *                                           empty and silent. PROPOSES ONLY;
 *                                           nothing is written without the
 *                                           user confirming it. The app's
 *                                           only outbound request, and the
 *                                           issuer form has a checkbox to
 *                                           refuse it.
 *
 * All nine paths are distinct literal prefixes, so mount order cannot change
 * which handler answers a request.
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
