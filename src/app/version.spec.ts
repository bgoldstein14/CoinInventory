/* Keeps the hand-maintained constant in version.ts in step with package.json. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { APP_BUILD, APP_RELEASE, APP_VERSION } from './version';

interface PackageJson {
  readonly version: string;
  readonly buildNumber: number;
}

const pkg = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf8')
) as PackageJson;

describe('the version the app shows', () => {
  it('matches the release in package.json', () => {
    expect(APP_RELEASE).toBe(pkg.version);
  });

  it('matches the build number in package.json', () => {
    expect(APP_BUILD).toBe(pkg.buildNumber);
  });

  it('is the four-part string, assembled from those two', () => {
    expect(APP_VERSION).toBe(`${pkg.version}.${pkg.buildNumber}`);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  // npm rejects a four-part version, so the build digit is a separate field.
  it('keeps package.json on a valid three-part semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof pkg.buildNumber).toBe('number');
  });

  // The release stays 1.0.0 until the first real release; update this then.
  it('is still pre-release, so only the build digit has moved', () => {
    expect(APP_RELEASE).toBe('1.0.0');
  });
});
