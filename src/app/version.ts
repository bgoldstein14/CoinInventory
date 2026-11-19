/*
 * The version the application shows and reports, as major.minor.patch.build.
 *
 * A hand-maintained constant because the browser bundle cannot read
 * package.json; version.spec.ts checks the two agree. package.json keeps
 * `version` and `buildNumber` separate because npm rejects four-part versions.
 */

/** major.minor.patch — frozen at 1.0.0 until the first real release. */
export const APP_RELEASE = '1.0.0';

/** The build digit. Incremented by `npm run bump-build`, never by hand. */
export const APP_BUILD = 0;

/** What the user sees: `1.0.0.0`. */
export const APP_VERSION = `${APP_RELEASE}.${APP_BUILD}`;
