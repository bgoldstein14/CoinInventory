/*
 * The version the application shows and reports.
 *
 * ---- WHY THIS IS A HAND-MAINTAINED CONSTANT ----
 * A browser bundle cannot read `package.json` at runtime, so the version has
 * to be compiled in. The two usual ways to do that are a build-time code
 * generator or a bundler define; both mean the number you see in the UI
 * exists nowhere you can grep for it, and a wrong version is then invisible
 * in review.
 *
 * So it is a plain constant, and `version.spec.ts` reads `package.json` in
 * Node and fails if the two disagree. The constant is reviewable and the
 * test is what stops it drifting.
 *
 * ---- THE SHAPE: major.minor.patch.build ----
 * `package.json` holds `version: "1.0.0"` and `buildNumber: 0` separately
 * because **`1.0.0.0` is not valid semver** and npm rejects a four-part
 * version outright. The four-part string is assembled for display only.
 *
 * The owner's rule, 2026-11-14: *"I don't think we should be advancing the
 * version past 1.0.0 until I actually have a release and start doing
 * modifications after that."* So the first three parts stay at 1.0.0 until
 * there is a real release to version against. Only the build digit moves,
 * via `npm run bump-build`.
 */

/** major.minor.patch — frozen at 1.0.0 until the first real release. */
export const APP_RELEASE = '1.0.0';

/** The build digit. Incremented by `npm run bump-build`, never by hand. */
export const APP_BUILD = 0;

/** What the user sees: `1.0.0.0`. */
export const APP_VERSION = `${APP_RELEASE}.${APP_BUILD}`;
