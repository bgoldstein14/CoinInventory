/**
 * issue-url.spec.ts — the deep link, and the clipboard fallback.
 *
 * ---- WHY A DEEP LINK AND NOT AN API CALL ----
 * Filing the issue from inside the app would mean shipping a GitHub
 * credential in a public desktop application. Any token that can file an
 * issue can be extracted from the binary and abused; that is not solvable,
 * only deferrable, and this design does not defer it — there is no token.
 *
 * A pre-filled URL costs the user one click, needs no secret, and has the
 * side benefit that they see exactly what they are submitting in GitHub's
 * own editor before pressing the button.
 *
 * ---- WHY THE CLIPBOARD FALLBACK IS NOT OPTIONAL ----
 * A URL has a practical length limit — browsers and servers both start
 * refusing somewhere around 8 KB, and GitHub is no exception. A report with
 * 150 log lines in it will blow past that routinely. VS Code's issue
 * reporter hit exactly this and solved it exactly this way: put the body on
 * the clipboard and tell the user, in those words, that it was too large to
 * put in the link.
 *
 * Silently truncating would be the worst option: the user would file a
 * report that LOOKS complete and is missing the part that mattered.
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

/**
 * The address the dialog shows as a CLICKABLE LINK before anything has been
 * built. Attaching a file is a GitHub-side action — the app has no way to
 * upload one — so telling the user that without handing them the link is
 * telling them to go and find it.
 */
describe('issuePageUrl', () => {
  it('points at the new-issue page', () => {
    expect(issuePageUrl(REPO)).toBe('https://github.com/owner/coin-inventory/issues/new');
  });

  /**
   * No query string. There is no title or body to encode at this point, and
   * a link ending `?title=&body=` reads as broken to anyone who looks at it.
   */
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

  /**
   * VS Code's wording, near enough, and for the same reason: the user is
   * about to land on an empty issue form and needs to know, without
   * guessing, that the content is on their clipboard and that pasting is
   * now their job.
   */
  it('the fallback URL body tells the user to paste', () => {
    const plan = planIssueSubmission(REPO, 't', 'x'.repeat(20_000));
    expect(decodeURIComponent(plan.url)).toMatch(/paste/i);
    expect(decodeURIComponent(plan.url)).toMatch(/clipboard/i);
  });

  it('says why it fell back, so the dialog can explain itself', () => {
    const plan = planIssueSubmission(REPO, 't', 'x'.repeat(20_000));
    expect(plan.reason).toMatch(/too large|too long/i);
  });

  /**
   * The boundary is where this goes wrong in practice: a body that is a
   * few characters over produces a URL the browser silently truncates, and
   * the user files half a report without knowing it.
   */
  it('decides on the ENCODED length, not the raw length', () => {
    // Newlines encode to three characters each, so a body of 4000 newlines
    // is 12,000 characters once encoded — comfortably over the limit even
    // though the raw string is under it.
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
    // Build a body whose encoded form lands just under the limit.
    const headroom = ISSUE_URL_MAX_CHARS - planIssueSubmission(REPO, 't', '').url.length - 10;
    const plan = planIssueSubmission(REPO, 't', 'z'.repeat(headroom));
    expect(plan.mode).toBe('url');
  });
});
