/*
 * Increments the build number (the fourth part of the displayed version).
 *
 *     npm run bump-build
 *
 * The four-part version is not valid semver, so package.json keeps `version`
 * (three-part) and `buildNumber` separately. The browser cannot read
 * package.json, so the build number is also written to src/app/version.ts;
 * src/app/version.spec.ts fails if the two disagree.
 * `version` itself is never changed here.
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

// Replace the field in place so the rest of package.json keeps its formatting.
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

// Both files are validated above before either is written.
writeFileSync(packagePath, updatedPkg, 'utf8');
writeFileSync(versionPath, updatedVersion, 'utf8');

console.log(`Build ${pkg.buildNumber} -> ${next}   (version now ${pkg.version}.${next})`);
console.log('Updated package.json and src/app/version.ts.');
