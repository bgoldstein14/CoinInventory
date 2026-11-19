/**
 * Scrubs a support report before it is written, so no unredacted copy ever
 * exists on disk (the zip, the preview and the GitHub URL all use redacted text).
 *
 * Replaces:
 *   <USER>      the Windows account name
 *   <USER2>…    other account names found in C:\Users\… paths
 *   <MACHINE>   this computer's name
 *   <MACHINE2>… other hosts in UNC paths, connection strings or SQL instances
 *   <REDACTED>  passwords, tokens, API keys, connection-string credentials
 *   <EMAIL>     email addresses
 *
 * Placeholders are stable (the same value always gets the same one) and
 * distinct (different values never share one), so the report stays useful
 * for reproducing bugs. The receipt shown to the user describes what was
 * replaced and how often, never the value itself.
 *
 * Rule order matters:
 *  1. `Authorization: …` is consumed to end of line first; the key=value rule
 *     would stop at "Bearer" and leave the token.
 *  2. URL credentials before anything else touches the URL.
 *  3. Secrets before identity, so a password containing the machine name is
 *     blanked whole.
 *  4. Email before username, so the domain isn't left behind.
 *  5. Path-shaped rules before bare tokens, so paths still read as paths.
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
  /** Plain words, never the replaced value. */
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

/** Host names never aliased: they identify nobody and show the app was talking to itself. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '.', '(local)']);

/**
 * Minimum length for the bare-token username rule. Very short names would
 * match inside ordinary words; the C:\Users\… path rule still covers them.
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
 * Works out who and what this machine is. Inputs are parameters so tests can
 * plant markers. The username falls back to the home directory's last
 * segment; a wrong guess can only over-redact.
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
 * Hands out stable placeholders. The current user and machine are reserved
 * as <USER> / <MACHINE>; others are numbered from 2 in first-seen order.
 * Case-insensitive, like Windows paths.
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
    // Must be first (see the module header).
    out = out.replace(
      /\b(authorization)(\s*[:=]\s*).+/gi,
      (_m, key: string, sep: string) => `${key}${sep}${this.hit('<REDACTED>')}`
    );

    // ---- 2. Credentials embedded in a URL ---------------------------------
    // The lookbehind avoids quadratic rescanning on long runs of letters
    // (a 200 KB line took over 30 s without it).
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
    // Longer alternatives first, so a prefix match can't leave part of the key in the value.
    out = out.replace(
      /\b(client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|password|passwd|pwd|pass|secret|token|user\s?id|uid)(\s*[:=]\s*)(["']?)([^;,&\s"']+)\3/gi,
      (_m, key: string, sep: string) => `${key}${sep}${this.hit('<REDACTED>')}`
    );

    // ---- 5. Email addresses ------------------------------------------------
    // Before the username rules, so the domain isn't left. Same lookbehind
    // guard against quadratic scanning as rule 2.
    out = out.replace(
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
      () => this.hit('<EMAIL>')
    );

    // ---- 6. The account segment of a C:\Users\… path -----------------------
    // Keeps the path shape: `C:/Users/<USER>/source/...`.
    out = out.replace(
      /([A-Za-z]:[\\/]Users[\\/])([^\\/\s:;"'<>|]+)/g,
      (_m, head: string, account: string) => `${head}${this.hit(this.users.aliasFor(account))}`
    );

    // ---- 6a. The host in a connection string -------------------------------
    // A bare `Server=HOMEPC;` (no named instance) isn't caught by rule 8 or 10.
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
    out = out.replace(
      /\b([A-Za-z0-9][A-Za-z0-9._-]{0,62})\\(SQLEXPRESS|MSSQLSERVER|SQLSERVER)\b/gi,
      (whole, host: string, instance: string) =>
        LOOPBACK_HOSTS.has(host.toLowerCase())
          ? whole
          : `${this.hit(this.machines.aliasFor(host))}\\${instance}`
    );

    // ---- 9. The username as a bare token ----------------------------------
    // Lookaround rather than \b so `devuser2` (someone else) is left alone.
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
      // Most-replaced first.
      .sort((a, b) => b.occurrences - a.occurrences || a.placeholder.localeCompare(b.placeholder));
  }
}

/**
 * A redactor whose placeholders are shared across every piece of one bundle,
 * so the report body and log tail agree on who <USER2> is.
 */
export function createRedactor(identity: RedactionIdentity): Redactor {
  return new RedactorImpl(identity);
}

/** One-shot convenience for a single piece of text. */
export function redact(text: string, identity: RedactionIdentity): RedactionResult {
  const redactor = createRedactor(identity);
  return { text: redactor.apply(text), receipt: redactor.receipt() };
}
