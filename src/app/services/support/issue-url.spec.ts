/**
 * Tests for the pre-filled GitHub issue link and its clipboard fallback for
 * bodies too long for a URL (see issue-url.ts).
 */

import { describe, it, expect } from 'vitest';

import {
  ISSUE_URL_MAX_CHARS,
  buildIssueUrl,
  issuePageUrl,
  normaliseRepositoryUrl,
  planIssueSubmission
} from './issue-url';

const REPO = 'https://github.com/owner/coin-inventory';

describe('normaliseRepositoryUrl', () => {
  it('leaves a plain repository URL alone', () => {
    expect(normaliseRepositoryUrl(REPO)).toBe(REPO);
  });

  it('strips a trailing slash', () => {
    expect(normaliseRepositoryUrl(`${REPO}/`)).toBe(REPO);
  });

  it('strips a .git suffix, which is what people paste from a clone command', () => {
    expect(normaliseRepositoryUrl(`${REPO}.git`)).toBe(REPO);
  });

  it('strips an /issues suffix, which is what people paste from the browser', () => {
    expect(normaliseRepositoryUrl(`${REPO}/issues`)).toBe(REPO);
  });
});

/** The plain new-issue link shown before any report is built. */
describe('issuePageUrl', () => {
  it('points at the new-issue page', () => {
    expect(issuePageUrl(REPO)).toBe('https://github.com/owner/coin-inventory/issues/new');
  });

  /** No `?title=&body=` when there is nothing to encode. */
  it('carries no empty query string', () => {
    expect(issuePageUrl(REPO)).not.toContain('?');
  });

  it('tidies the three things people paste when asked for a repository URL', () => {
    expect(issuePageUrl(`${REPO}/`)).toBe(`${REPO}/issues/new`);
    expect(issuePageUrl(`${REPO}.git`)).toBe(`${REPO}/issues/new`);
    expect(issuePageUrl(`${REPO}/issues`)).toBe(`${REPO}/issues/new`);
  });
});

describe('buildIssueUrl', () => {
  it('points at the new-issue page', () => {
    expect(buildIssueUrl(REPO, { title: 'x', body: 'y' }))
      .toContain('https://github.com/owner/coin-inventory/issues/new?');
  });

  it('encodes the title and body', () => {
    const url = buildIssueUrl(REPO, { title: 'Save & exit broke', body: 'line one\nline two' });
    expect(url).toContain('title=Save%20%26%20exit%20broke');
    expect(url).toContain('body=line%20one%0Aline%20two');
  });

  it('passes a template name through when one is given', () => {
    const url = buildIssueUrl(REPO, { title: 't', body: 'b', template: 'bug_report.yml' });
    expect(url).toContain('template=bug_report.yml');
  });

  it('passes labels through', () => {
    const url = buildIssueUrl(REPO, { title: 't', body: 'b', labels: ['bug', 'from-app'] });
    expect(url).toContain('labels=bug%2Cfrom-app');
  });

  it('survives a repository URL with a trailing slash', () => {
    expect(buildIssueUrl(`${REPO}/`, { title: 't', body: 'b' }))
      .toContain('/coin-inventory/issues/new?');
  });
});

describe('planIssueSubmission', () => {
  it('uses the URL when the body fits', () => {
    const plan = planIssueSubmission(REPO, 'Export crashes', 'it broke at step four');

    expect(plan.mode).toBe('url');
    expect(plan.url).toContain('body=it%20broke');
    expect(plan.clipboardText).toBeNull();
  });

  it('falls back to the clipboard when the body is too long', () => {
    const plan = planIssueSubmission(REPO, 'Export crashes', 'x'.repeat(20_000));

    expect(plan.mode).toBe('clipboard');
    expect(plan.clipboardText).toContain('x'.repeat(20_000));
  });

  it('the fallback URL still opens the issue form, with the title kept', () => {
    const plan = planIssueSubmission(REPO, 'Export crashes', 'x'.repeat(20_000));

    expect(plan.url).toContain('/issues/new?');
    expect(plan.url).toContain('title=Export%20crashes');
    expect(plan.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS);
  });

  /** The user lands on an empty form and must be told the content is on the clipboard. */
  it('the fallback URL body tells the user to paste', () => {
    const plan = planIssueSubmission(REPO, 't', 'x'.repeat(20_000));
    expect(decodeURIComponent(plan.url)).toMatch(/paste/i);
    expect(decodeURIComponent(plan.url)).toMatch(/clipboard/i);
  });

  it('says why it fell back, so the dialog can explain itself', () => {
    const plan = planIssueSubmission(REPO, 't', 'x'.repeat(20_000));
    expect(plan.reason).toMatch(/too large|too long/i);
  });

  it('decides on the ENCODED length, not the raw length', () => {
    // Each newline encodes to three characters: 12,000 encoded from 4,000 raw.
    const plan = planIssueSubmission(REPO, 't', '\n'.repeat(4000));
    expect(plan.mode).toBe('clipboard');
  });

  it('never returns a URL longer than the limit', () => {
    for (const size of [1, 100, 7_000, 7_900, 8_100, 50_000]) {
      const plan = planIssueSubmission(REPO, 'a title', 'y'.repeat(size));
      expect(plan.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS);
    }
  });

  it('a body that fits exactly is still sent by URL', () => {
    // A body whose encoded form lands just under the limit.
    const headroom = ISSUE_URL_MAX_CHARS - planIssueSubmission(REPO, 't', '').url.length - 10;
    const plan = planIssueSubmission(REPO, 't', 'z'.repeat(headroom));
    expect(plan.mode).toBe('url');
  });
});
