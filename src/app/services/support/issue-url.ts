/**
 * issue-url.ts — building the pre-filled GitHub issue link.
 *
 * ---- NO TOKEN. EVER. ----
 * The app does not talk to GitHub. It opens the user's own browser at a
 * new-issue URL with the title and body already filled in, and the user
 * presses Submit themselves.
 *
 * The alternative — POST to the GitHub API from inside the app — requires
 * shipping a credential in a public desktop application. Any token that can
 * file an issue can be extracted from the binary and abused. That is not a
 * problem that gets solved by obfuscation, a proxy, or hoping; the only
 * honest answer is not to have one. The deep link costs one click, and it
 * has the side benefit that the user sees the whole submission in GitHub's
 * own editor before anything is published.
 *
 * GitHub also has no official API for issue ATTACHMENTS — only undocumented
 * routes that disagree about whether a token even works — so even a token
 * would not get a file up there. Dragging it in is the only route that
 * exists, which is why the dialog hands the user this link rather than a
 * file picker it could not honour.
 *
 * ---- THE CLIPBOARD FALLBACK IS LOAD-BEARING ----
 * URLs have a practical ceiling — browsers and servers both start refusing
 * somewhere around 8 KB. A report carrying 150 log lines sails past it
 * routinely. The failure mode if we ignore this is the worst one available:
 * the browser silently truncates, GitHub opens with half a report in it, and
 * the user submits something that LOOKS complete.
 *
 * So the length is checked before opening anything. Over the limit, the body
 * goes on the clipboard and the URL carries a short instruction instead —
 * which is exactly what VS Code's issue reporter does, in nearly these
 * words: "We have written the needed data into your clipboard because it was
 * too large to send."
 */

/**
 * The longest URL we are willing to hand to a browser.
 *
 * 8 KB is the conventional ceiling (it is the default request-line limit in
 * most servers and roughly where browsers stop honouring long URLs). 8000
 * leaves a little room rather than sitting on the boundary, because being
 * wrong here is silent.
 */
export const ISSUE_URL_MAX_CHARS = 8000;

/** GitHub truncates issue titles; keep ours comfortably inside. */
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
  /** Always safe to open. Under the length limit in both modes. */
  url: string;
  /** The full body, when the caller must put it on the clipboard first. */
  clipboardText: string | null;
  /** Plain-words explanation for the dialog, when mode is 'clipboard'. */
  reason?: string;
}

/**
 * Tidy whatever was configured as "the repository".
 *
 * People paste three different things when asked for a repo URL: the browser
 * address (…/coin-inventory), the clone command's URL (…/coin-inventory.git)
 * and the issues page (…/coin-inventory/issues). All three mean the same
 * repository and all three produce a broken link if pasted straight into
 * `${repo}/issues/new`.
 */
export function normaliseRepositoryUrl(repoUrl: string): string {
  let url = repoUrl.trim();

  // Repeated because the forms combine: '…/issues/' and '….git/' both occur.
  for (let pass = 0; pass < 3; pass++) {
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/issues$/i, '');
    url = url.replace(/\.git$/i, '');
  }

  return url;
}

/**
 * The plain new-issue page, with nothing filled in.
 *
 * WHY THIS IS SEPARATE FROM buildIssueUrl. The dialog shows the user a
 * CLICKABLE LINK on the describe step, before any report exists — that is
 * the owner's explicit requirement, because attaching files is a GitHub-side
 * action and telling someone to go to GitHub without giving them the address
 * is telling them to go and find it. There is no title or body to encode at
 * that point, and a link with `?title=&body=` in it looks broken.
 */
export function issuePageUrl(repoUrl: string): string {
  return `${normaliseRepositoryUrl(repoUrl)}/issues/new`;
}

/**
 * The pre-filled link.
 *
 * Encoded with `encodeURIComponent` rather than `URLSearchParams`, which
 * would encode spaces as `+`. GitHub accepts both, but `%20` is what shows
 * up if the user ever looks at the link, and a body full of `+` where the
 * spaces should be is alarming to read.
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
 * Decide how this report gets to GitHub.
 *
 * NOTE THE LENGTH IS MEASURED ON THE FINISHED, ENCODED URL. Checking the raw
 * body would be wrong by a factor of three for text full of newlines — each
 * `\n` becomes `%0A` — and newline-heavy is exactly what a log tail is.
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
