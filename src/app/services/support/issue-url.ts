/**
 * Builds the pre-filled GitHub new-issue link. The app never calls GitHub
 * itself (no token is shipped); the user's browser opens the link and the
 * user submits. GitHub has no official attachment API, so files are added by
 * dragging them into the issue.
 *
 * URLs over about 8 KB are refused or truncated, so the encoded length is
 * checked first. If it is too long, the body goes on the clipboard and the URL
 * carries a short "paste it here" instruction (as VS Code's issue reporter does).
 */

/** Longest URL handed to a browser; just under the conventional 8 KB limit. */
export const ISSUE_URL_MAX_CHARS = 8000;

/** GitHub truncates long titles. */
const MAX_TITLE_CHARS = 200;

/** What the fallback URL says when the real body went to the clipboard. */
const CLIPBOARD_FALLBACK_BODY =
  'The problem report was too large to fit in a link, so it has been copied ' +
  'to your clipboard. Please paste it here (Ctrl+V). You can also drag in ' +
  'the report file that was saved to your Desktop, along with any ' +
  'screenshots or exports you want to include — images display inline.';

const TOO_LARGE_REASON =
  'The report was too large to fit in a browser link, so it was copied to your clipboard instead.';

export interface IssueFields {
  title: string;
  body: string;
  labels?: readonly string[];
  /** A file name from .github/ISSUE_TEMPLATE/, e.g. 'bug_report.yml'. */
  template?: string;
}

export type IssueSubmissionMode = 'url' | 'clipboard';

export interface IssuePlan {
  mode: IssueSubmissionMode;
  /** Always under the length limit. */
  url: string;
  /** The full body, when the caller must put it on the clipboard first. */
  clipboardText: string | null;
  /** Plain-words explanation for the dialog, when mode is 'clipboard'. */
  reason?: string;
}

/**
 * Normalises a configured repository URL: accepts the browser address, the
 * `.git` clone URL or the issues page.
 */
export function normaliseRepositoryUrl(repoUrl: string): string {
  let url = repoUrl.trim();

  // Repeated because the suffixes can combine ('.../issues/', '....git/').
  for (let pass = 0; pass < 3; pass++) {
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/issues$/i, '');
    url = url.replace(/\.git$/i, '');
  }

  return url;
}

/**
 * The plain new-issue page with nothing filled in, shown as a link before a
 * report exists so the user can attach files on GitHub.
 */
export function issuePageUrl(repoUrl: string): string {
  return `${normaliseRepositoryUrl(repoUrl)}/issues/new`;
}

/**
 * The pre-filled link. Uses `encodeURIComponent` so spaces show as `%20`
 * rather than `+`.
 */
export function buildIssueUrl(repoUrl: string, fields: IssueFields): string {
  const base = `${normaliseRepositoryUrl(repoUrl)}/issues/new`;

  const parts = [
    `title=${encodeURIComponent(fields.title.slice(0, MAX_TITLE_CHARS))}`,
    `body=${encodeURIComponent(fields.body)}`
  ];

  if (fields.labels && fields.labels.length > 0) {
    parts.push(`labels=${encodeURIComponent(fields.labels.join(','))}`);
  }
  if (fields.template) {
    parts.push(`template=${encodeURIComponent(fields.template)}`);
  }

  return `${base}?${parts.join('&')}`;
}

/**
 * Decides between a direct link and the clipboard fallback. Measured on the
 * encoded URL: each newline becomes `%0A`, and log tails are newline-heavy.
 */
export function planIssueSubmission(
  repoUrl: string,
  title: string,
  body: string,
  maxChars: number = ISSUE_URL_MAX_CHARS,
  fields: Omit<IssueFields, 'title' | 'body'> = {}
): IssuePlan {
  const full = buildIssueUrl(repoUrl, { ...fields, title, body });
  if (full.length <= maxChars) {
    return { mode: 'url', url: full, clipboardText: null };
  }

  return {
    mode: 'clipboard',
    url: buildIssueUrl(repoUrl, { ...fields, title, body: CLIPBOARD_FALLBACK_BODY }),
    clipboardText: body,
    reason: TOO_LARGE_REASON
  };
}
