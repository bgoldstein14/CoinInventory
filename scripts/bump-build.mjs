/*
 * scripts/bump-build.mjs — move the build digit, and only the build digit.
 *
 *     npm run bump-build
 *
 * ---- WHY THE VERSION LIVES IN TWO PLACES ----
 * The app shows `1.0.0.0`, which is the Windows file-version convention
 * (Major.Minor.Build.Revision) and the right shape for something that ships
 * as a setup.exe. It is NOT valid semver — npm rejects a four-part version
 * outright — so `package.json` carries `version: "1.0.0"` and
 * `buildNumber: 0` as separate fields, and the four-part string is assembled
 * for display.
 *
 * A browser bundle cannot read `package.json` at runtime, so the number is
 * also compiled into `src/app/version.ts`. That is two copies, which is a
 * liability; `src/app/version.spec.ts` fails if they disagree, and this
 * script is the only thing that should ever write either of them.
 *
 * ---- WHAT THIS DELIBERATELY DOES NOT DO ----
 * It does not touch `version`. The owner's rule, 2026-11-14: the release
 * stays at 1.0.0 until there is a real release to version against. When that
 * day comes, edit `package.json`, `src/app/version.ts` and the "still
 * pre-release" test together, on purpose.
 *
 * It is not wired into `npm run build` either. A build digit that moves on
 * every local compile turns every diff into noise and tells you nothing
 * about which build a user is running. Run it when you cut something.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(root, 'package.json');
const versionPath = join(root, 'src', 'app', 'version.ts');

const pkgText = readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(pkgText);

if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.error(`package.json "version" must be three-part semver, found: ${pkg.version}`);
  process.exit(1);
}
if (typeof pkg.buildNumber !== 'number' || !Number.isInteger(pkg.buildNumber)) {
  console.error(`package.json "buildNumber" must be a whole number, found: ${pkg.buildNumber}`);
  process.exit(1);
}

const next = pkg.buildNumber + 1;

// Rewrite the one field by hand rather than re-serialising the whole object:
// JSON.stringify would reformat a file people read and review.
const updatedPkg = pkgText.replace(
  /("buildNumber"\s*:\s*)\d+/,
  (_match, prefix) => `${prefix}${next}`
);
if (updatedPkg === pkgText) {
  console.error('Could not find "buildNumber" in package.json to update.');
  process.exit(1);
}

const versionText = readFileSync(versionPath, 'utf8');
const updatedVersion = versionText.replace(
  /(export const APP_BUILD = )\d+/,
  (_match, prefix) => `${prefix}${next}`
);
if (updatedVersion === versionText) {
  console.error(`Could not find "export const APP_BUILD = <n>" in ${versionPath}.`);
  process.exit(1);
}

// Both or neither: a half-applied bump is the one state the drift test exists
// to catch, and leaving it behind would be this script causing the problem it
// is meant to prevent.
writeFileSync(packagePath, updatedPkg, 'utf8');
writeFileSync(versionPath, updatedVersion, 'utf8');

console.log(`Build ${pkg.buildNumber} -> ${next}   (version now ${pkg.version}.${next})`);
console.log('Updated package.json and src/app/version.ts.');
