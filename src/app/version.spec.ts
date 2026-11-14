/*
 * The only thing stopping the displayed version drifting from the real one.
 *
 * `version.ts` is a hand-maintained constant because a browser bundle cannot
 * read `package.json` at runtime. That is a reasonable trade only while
 * something checks the two agree — otherwise the number in the title bar and
 * the number in a support report can disagree, and the support report is the
 * one a bug gets filed against.
 *
 * This matters more than it looks: before 2026-11-14 the root `package.json`
 * still said `0.0.0`, so every support report the app had ever written
 * claimed to come from version 0.0.0.
 */

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

  /*
   * npm rejects a four-part version, which is the whole reason the build
   * digit is a separate field. If someone "tidies" them into one string,
   * `npm install` starts failing in a way that looks unrelated to this.
   */
  it('keeps package.json on a valid three-part semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof pkg.buildNumber).toBe('number');
  });

  /*
   * The owner's rule: the release stays 1.0.0 until there is a real release
   * to version against, and only the build digit moves. This test is a
   * deliberate speed bump, not a law — when he does ship, change it.
   */
  it('is still pre-release, so only the build digit has moved', () => {
    expect(APP_RELEASE).toBe('1.0.0');
  });
});
