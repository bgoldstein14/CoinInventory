/**
 * support/redaction.ts — scrub a support report before it is written.
 *
 * THIS RUNS BEFORE THE FILE IS WRITTEN, NOT BEFORE IT IS SENT. Building the
 * bundle and redacting on the way out is the wrong order: once an unredacted
 * copy exists on disk, somebody will attach THAT one. The zip on the user's
 * Desktop, the text in the preview box and the body of the GitHub URL are all
 * produced from already-redacted text, so there is never an unredacted
 * artefact to pick up by mistake.
 *
 * WHAT IT REPLACES
 *   <USER>      the Windows account name, wherever it appears
 *   <USER2>…    any OTHER account name found in a C:\Users\… path
 *   <MACHINE>   this computer's name
 *   <MACHINE2>… any other host named in a UNC path or SQL instance
 *   <REDACTED>  passwords, tokens, API keys, connection-string credentials
 *   <EMAIL>     email addresses
 *
 * Real log lines from this application look like:
 *
 *   Connecting to SQL Server at MYSERVER\SQLEXPRESS/CoinInventory
 *     at formatDate (C:/Users/devuser/source/dev/server/server.ts:130:12)
 *
 * — so both the machine name and the username are present in ordinary,
 * uninteresting lines. There is no "only redact the scary ones" option.
 *
 * WHY THE PLACEHOLDERS ARE STABLE AND DISTINCT
 * These reports are read in order to REPRODUCE bugs. Two requirements follow,
 * and they pull in opposite directions:
 *
 *   stable     the same folder must read as the same folder every time it
 *              appears, or "the file is in A, we looked in B" becomes
 *              unreadable. So a fixed placeholder per value, allocated once
 *              and reused for the whole bundle.
 *
 *   distinct   two different accounts must NOT collapse onto one placeholder,
 *              or the report invents an equality that is not there. So the
 *              second account seen becomes <USER2>, not <USER>.
 *
 * A hash-based placeholder would satisfy both but is unreadable;
 * sequential numbering satisfies both and a human can hold it in their head.
 *
 * THE RECEIPT NEVER CONTAINS THE SECRET
 * "Tell the user what was replaced" is a requirement, and the obvious
 * implementation — "replaced 'devuser' 4 times" — hands back the exact thing
 * that was just removed, into the same document. The receipt therefore
 * carries a PLAIN-WORDS DESCRIPTION and a count, never a value. There is a
 * canary test for precisely this.
 *
 * ORDER MATTERS
 * The rules below run in the order they are written and the order is load
 * bearing, not incidental:
 *
 *  1. `Authorization: …` is consumed to end of line FIRST. If the generic
 *     key=value rule ran first it would stop at the first whitespace and
 *     produce `Authorization: <REDACTED> eyJhbGciOi…` — redacting the word
 *     "Bearer" and publishing the token. That is a genuine bug this ordering
 *     prevents, not a hypothetical one.
 *  2. URL credentials before anything else touches the URL.
 *  3. Secrets before identity, so a password that happens to contain the
 *     machine name is blanked whole rather than partly substituted.
 *  4. Email before the username rule, so `devuser@example.com` becomes
 *     <EMAIL> rather than <USER>@example.com (which still leaks the domain).
 *  5. Path-shaped rules before bare-token rules, so the common case produces
 *     a path that still looks like a path.
 */

/** What we know about the machine the report is being produced on. */
export interface RedactionIdentity {
  username?: string;
  machineName?: string;
  homeDir?: string;
}

/** One line of the "here is what we took out" summary shown to the user. */
export interface RedactionReceiptEntry {
  placeholder: string;
  /** Plain words. NEVER the replaced value — see the module header. */
  what: string;
  occurrences: number;
}

export interface RedactionResult {
  text: string;
  receipt: RedactionReceiptEntry[];
}

/** A redactor with one allocation table, shared across a whole bundle. */
export interface Redactor {
  apply(text: string): string;
  receipt(): RedactionReceiptEntry[];
}

/**
 * Host names that are never aliased.
 *
 * These identify nobody, and replacing them actively destroys information:
 * "could not reach <MACHINE2>" hides the one useful fact in the line, which
 * is that the app was talking to itself.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '.', '(local)']);

/**
 * Minimum length for the bare-token username rule.
 *
 * A one or two character account name ('jd', 'a') occurs inside ordinary
 * English and inside half the identifiers in a stack trace. Matching it would
 * shred the report. The path rule still covers the dangerous case —
 * `C:\Users\a\…` — so stepping aside here costs nothing real.
 */
const MIN_BARE_TOKEN_LENGTH = 3;

/** Escape a value so it can be dropped into a RegExp as a literal. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A trimmed, non-empty string, or undefined. Blank env vars are not names. */
function cleanName(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Last path segment of a home directory: the best available guess at a user name. */
function lastSegment(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const parts = dir.split(/[\\/]+/).filter(p => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

/**
 * Work out who and what this machine is.
 *
 * `env`, `hostname` and `homedir` are parameters rather than direct calls to
 * `process.env` / `os` so the canary tests can plant a marker in each of them
 * without touching the real process.
 *
 * The USERNAME fallback chain ends at the last segment of the home directory
 * because a wrong guess there can only OVER-redact, and over-redaction is the
 * safe direction of failure for this module.
 */
export function identityFromEnvironment(
  env: Record<string, string | undefined>,
  hostname: string,
  homedir: string
): RedactionIdentity {
  const homeDir = cleanName(env['USERPROFILE']) ?? cleanName(env['HOME']) ?? cleanName(homedir);

  return {
    username:
      cleanName(env['USERNAME']) ??
      cleanName(env['USER']) ??
      lastSegment(homeDir),
    machineName: cleanName(env['COMPUTERNAME']) ?? cleanName(hostname),
    homeDir
  };
}

/**
 * Plain-words explanation of a placeholder, for the receipt and for the
 * "what we replaced" block in the report itself.
 */
export function describePlaceholder(placeholder: string): string {
  if (placeholder === '<USER>') return 'your Windows user name';
  if (/^<USER\d+>$/.test(placeholder)) return 'another Windows user name found in a file path';
  if (placeholder === '<MACHINE>') return 'your computer name';
  if (/^<MACHINE\d+>$/.test(placeholder)) return 'another computer or server name';
  if (placeholder === '<REDACTED>') {
    return 'something that looked like a password, token, API key or connection-string credential';
  }
  if (placeholder === '<EMAIL>') return 'an email address';
  return 'personal information';
}

/**
 * Hands out stable placeholders.
 *
 * The current user and the current machine are reserved up front, so they get
 * the unnumbered `<USER>` / `<MACHINE>` even if some other account happens to
 * be mentioned earlier in the text. Everything else is numbered from 2 in
 * first-seen order.
 *
 * Keyed case-insensitively: Windows paths are case-insensitive, so
 * `C:\USERS\DevUser` and `c:\users\devuser` are the same person and must not
 * be handed two different placeholders.
 */
class AliasTable {
  private readonly assigned = new Map<string, string>();
  private next = 2;

  constructor(private readonly prefix: 'USER' | 'MACHINE', reserved?: string) {
    if (reserved) this.assigned.set(reserved.toLowerCase(), `<${prefix}>`);
  }

  aliasFor(value: string): string {
    const key = value.toLowerCase();
    const existing = this.assigned.get(key);
    if (existing) return existing;

    const alias = `<${this.prefix}${this.next++}>`;
    this.assigned.set(key, alias);
    return alias;
  }
}

class RedactorImpl implements Redactor {
  private readonly counts = new Map<string, number>();
  private readonly users: AliasTable;
  private readonly machines: AliasTable;

  constructor(private readonly identity: RedactionIdentity) {
    this.users = new AliasTable('USER', identity.username);
    this.machines = new AliasTable('MACHINE', identity.machineName);
  }

  /** Record one replacement against a placeholder, and return the placeholder. */
  private hit(placeholder: string): string {
    this.counts.set(placeholder, (this.counts.get(placeholder) ?? 0) + 1);
    return placeholder;
  }

  apply(text: string): string {
    if (text.length === 0) return text;

    let out = text;

    // ---- 1. Authorization header, consumed to end of line -----------------
    // MUST be first. See the module header: the generic key=value rule would
    // stop at the space after "Bearer" and publish the token.
    out = out.replace(
      /\b(authorization)(\s*[:=]\s*).+/gi,
      (_m, key: string, sep: string) => `${key}${sep}${this.hit('<REDACTED>')}`
    );

    // ---- 2. Credentials embedded in a URL ---------------------------------
    //
    // The leading lookbehind is a PERFORMANCE guard, not a correctness one.
    // Without it the engine starts a scheme match at every character of a
    // long run of letters and abandons it on the missing `://`, which is
    // quadratic — a 200 KB log line took over 30 seconds. The lookbehind
    // means only genuine token starts are attempted.
    out = out.replace(
      /(?<![A-Za-z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/g,
      (_m, scheme: string) => `${scheme}${this.hit('<REDACTED>')}@`
    );

    // ---- 3. A bare bearer token not preceded by "Authorization:" ----------
    out = out.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      () => `Bearer ${this.hit('<REDACTED>')}`
    );

    // ---- 4. key = value secrets -------------------------------------------
    // Longer alternatives are listed before the shorter ones they contain so
    // the alternation cannot match a prefix and leave the rest in the value.
    out = out.replace(
      /\b(client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|passwd|pwd|pass|secret|token|user\s?id|uid)(\s*[:=]\s*)(["']?)([^;,&\s"']+)\3/gi,
      (_m, key: string, sep: string) => `${key}${sep}${this.hit('<REDACTED>')}`
    );

    // ---- 5. Email addresses ------------------------------------------------
    // Before the username rules: `devuser@example.com` should become <EMAIL>,
    // not `<USER>@example.com`, which still publishes the domain.
    // Same quadratic-scan guard as the URL rule above: without the
    // lookbehind, a long run of word characters with no `@` in it is
    // re-scanned from every offset.
    out = out.replace(
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
      () => this.hit('<EMAIL>')
    );

    // ---- 6. The account segment of a C:\Users\… path -----------------------
    // Keeps the path SHAPE, which is what makes the report debuggable:
    // `C:/Users/<USER>/source/dev/...` still reads as a path.
    out = out.replace(
      /([A-Za-z]:[\\/]Users[\\/])([^\\/\s:;"'<>|]+)/g,
      (_m, head: string, account: string) => `${head}${this.hit(this.users.aliasFor(account))}`
    );

    // ---- 6a. The host in a connection string -------------------------------
    //
    // Rule 8 below catches `HOMEPC\SQLEXPRESS`, but a bare `Server=HOMEPC;`
    // — the form with no named instance — goes through untouched, publishing
    // a machine name that is not THIS machine and so is not covered by rule
    // 10 either. Loopback is exempt for the same reason as below.
    out = out.replace(
      /\b(Server|Data Source|Address|Addr|Network Address)(\s*=\s*)((?:tcp:)?)([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
      (whole, key: string, sep: string, scheme: string, host: string) =>
        LOOPBACK_HOSTS.has(host.toLowerCase())
          ? whole
          : `${key}${sep}${scheme}${this.hit(this.machines.aliasFor(host))}`
    );

    // ---- 7. The host in a UNC path ----------------------------------------
    out = out.replace(
      /\\\\([A-Za-z0-9][A-Za-z0-9._-]{0,62})\\/g,
      (whole, host: string) =>
        LOOPBACK_HOSTS.has(host.toLowerCase())
          ? whole
          : `\\\\${this.hit(this.machines.aliasFor(host))}\\`
    );

    // ---- 8. The host in a SQL Server instance name ------------------------
    // `MYSERVER\SQLEXPRESS` is in every connection log line this app writes.
    out = out.replace(
      /\b([A-Za-z0-9][A-Za-z0-9._-]{0,62})\\(SQLEXPRESS|MSSQLSERVER|SQLSERVER)\b/gi,
      (whole, host: string, instance: string) =>
        LOOPBACK_HOSTS.has(host.toLowerCase())
          ? whole
          : `${this.hit(this.machines.aliasFor(host))}\\${instance}`
    );

    // ---- 9. The username as a bare token ----------------------------------
    // Lookaround rather than \b so that `devuser2` is left alone: it is
    // somebody else, and rewriting it to `<USER>2` would read as this user
    // with a digit stuck on.
    const username = this.identity.username;
    if (username && username.length >= MIN_BARE_TOKEN_LENGTH) {
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(username)}(?![A-Za-z0-9_])`, 'gi'),
        () => this.hit('<USER>')
      );
    }

    // ---- 10. The machine name as a bare token ------------------------------
    const machineName = this.identity.machineName;
    if (machineName && machineName.length >= MIN_BARE_TOKEN_LENGTH) {
      out = out.replace(
        new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(machineName)}(?![A-Za-z0-9_])`, 'gi'),
        () => this.hit('<MACHINE>')
      );
    }

    return out;
  }

  receipt(): RedactionReceiptEntry[] {
    return [...this.counts.entries()]
      .map(([placeholder, occurrences]) => ({
        placeholder,
        what: describePlaceholder(placeholder),
        occurrences
      }))
      // Most-replaced first: it is the most useful ordering for somebody
      // skimming "what did it take out of my report".
      .sort((a, b) => b.occurrences - a.occurrences || a.placeholder.localeCompare(b.placeholder));
  }
}

/**
 * A redactor whose placeholder allocation is shared across every piece of one
 * bundle — the report body, the log tail, the file listing.
 *
 * Using a fresh redactor per piece would be a correctness bug, not an
 * inefficiency: `alice` could be <USER2> in the report and <USER3> in the log
 * tail, and the two halves of the bundle would then disagree about how many
 * people are involved.
 */
export function createRedactor(identity: RedactionIdentity): Redactor {
  return new RedactorImpl(identity);
}

/** One-shot convenience for a single piece of text. */
export function redact(text: string, identity: RedactionIdentity): RedactionResult {
  const redactor = createRedactor(identity);
  return { text: redactor.apply(text), receipt: redactor.receipt() };
}
