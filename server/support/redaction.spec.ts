/**
 * support/redaction.spec.ts
 *
 * THE CANARY TESTS ARE THE POINT OF THIS FILE
 * Everything else here is a unit test of a regular expression. The canary
 * block at the bottom is the only thing that demonstrates the FEATURE works,
 * and it works by seeding one marker string into
 * a username, a machine name, a folder path, a file name and a connection
 * string, run the real report text through the real redactor, then assert the
 * marker does not appear anywhere in the output — not in the text, not in the
 * receipt, not in a key, not in a count.
 *
 * Testing "does the username rule replace the username" proves the rule
 * exists. Only the canary proves nothing LEAKED, which is the actual promise
 * being made to somebody about to paste this into a public issue.
 *
 * STABILITY IS A REQUIREMENT, NOT A NICETY
 * These reports are read in order to reproduce bugs. If the same path were
 * replaced with a different placeholder each time it occurred, two log lines
 * about the same folder would read as two different folders and the report
 * would actively mislead. So the same input always maps to the same
 * placeholder, and — importantly — two DIFFERENT users do not collapse onto
 * the same one.
 */

import { describe, it, expect } from 'vitest';

import {
  createRedactor,
  describePlaceholder,
  identityFromEnvironment,
  redact
} from './redaction';

const IDENTITY = {
  username: 'devuser',
  machineName: 'MYSERVER',
  homeDir: 'C:\\Users\\devuser'
};

/** Shorthand: redact with the standard test identity, text only. */
function r(text: string): string {
  return redact(text, IDENTITY).text;
}

// Identity discovery

describe('identityFromEnvironment', () => {
  it('reads the Windows username, computer name and home folder', () => {
    const identity = identityFromEnvironment(
      { USERNAME: 'devuser', COMPUTERNAME: 'MYSERVER', USERPROFILE: 'C:\\Users\\devuser' },
      'MYSERVER',
      'C:\\Users\\devuser'
    );

    expect(identity.username).toBe('devuser');
    expect(identity.machineName).toBe('MYSERVER');
    expect(identity.homeDir).toBe('C:\\Users\\devuser');
  });

  it('falls back to os.hostname() and os.homedir() when the env vars are absent', () => {
    const identity = identityFromEnvironment({}, 'linux-box', '/home/dev');
    expect(identity.machineName).toBe('linux-box');
    expect(identity.homeDir).toBe('/home/dev');
    // No USERNAME/USER: the last segment of the home directory is the best
    // guess available, and a wrong guess here only over-redacts.
    expect(identity.username).toBe('dev');
  });

  it('ignores blank environment values rather than treating them as a name', () => {
    // A rule built from '' would match the empty string between every pair of
    // characters and destroy the whole document.
    const identity = identityFromEnvironment({ USERNAME: '   ', COMPUTERNAME: '' }, 'host', '/root');
    expect(identity.username).toBe('root');
    expect(identity.machineName).toBe('host');
  });
});

// The username

describe('the Windows username', () => {
  it('is replaced inside a path, leaving the path shape intact', () => {
    expect(r('  at formatDate (C:/Users/devuser/source/dev/server/server.ts:130:12)'))
      .toBe('  at formatDate (C:/Users/<USER>/source/dev/server/server.ts:130:12)');
  });

  it('is replaced with backslashes too', () => {
    expect(r('C:\\Users\\devuser\\Pictures\\Coins')).toBe('C:\\Users\\<USER>\\Pictures\\Coins');
  });

  it('is case-insensitive — Windows paths are', () => {
    expect(r('C:\\USERS\\DevUser\\Pictures')).toBe('C:\\USERS\\<USER>\\Pictures');
  });

  it('is replaced on its own, not only inside a path', () => {
    expect(r('login failed for devuser')).toBe('login failed for <USER>');
  });

  /**
   * THE WHOLE REASON THE PLACEHOLDER IS STABLE. The reader needs to see that
   * these two lines are about the same folder.
   */
  it('maps the same user to the same placeholder every time', () => {
    const out = r('C:/Users/devuser/a and C:/Users/devuser/b');
    expect(out).toBe('C:/Users/<USER>/a and C:/Users/<USER>/b');
  });

  it('does not collapse a DIFFERENT user onto the same placeholder', () => {
    const out = r('C:\\Users\\devuser\\x and C:\\Users\\alice\\y');
    expect(out).toContain('<USER>\\x');
    expect(out).toContain('<USER2>\\y');
    expect(out).not.toContain('alice');
  });

  it('gives a third user a third placeholder, consistently', () => {
    const out = r('C:\\Users\\alice\\1 C:\\Users\\bob\\2 C:\\Users\\alice\\3');
    expect(out).toBe('C:\\Users\\<USER2>\\1 C:\\Users\\<USER3>\\2 C:\\Users\\<USER2>\\3');
  });

  it('leaves a name that merely contains the username alone', () => {
    // 'devuser2' is somebody else. Substring matching would rewrite it to
    // '<USER>2', which reads as the same person with a digit after them.
    expect(r('account devuser2 locked')).toBe('account devuser2 locked');
  });

  /**
   * A one or two character username ('jd', 'a') cannot be matched safely —
   * it occurs inside ordinary English and inside every other identifier in a
   * stack trace. Over-redaction destroys the report; this rule steps aside
   * and the path rule still covers the dangerous case.
   */
  it('skips a username too short to match safely', () => {
    const out = redact('a quick brown fox at C:\\Users\\a\\pics', { username: 'a' }).text;
    expect(out).toBe('a quick brown fox at C:\\Users\\<USER>\\pics');
  });
});

// The machine name

describe('the machine name', () => {
  it('is replaced in the real connection log line', () => {
    expect(r('Connecting to SQL Server at MYSERVER\\SQLEXPRESS/CoinInventory'))
      .toBe('Connecting to SQL Server at <MACHINE>\\SQLEXPRESS/CoinInventory');
  });

  it('is replaced in a UNC path', () => {
    expect(r('\\\\MYSERVER\\Coin Pictures\\1881-S.jpg'))
      .toBe('\\\\<MACHINE>\\Coin Pictures\\1881-S.jpg');
  });

  it('replaces some OTHER server named in a UNC path, with its own placeholder', () => {
    const out = r('\\\\NAS01\\photos and \\\\NAS02\\photos and \\\\NAS01\\more');
    expect(out).toBe('\\\\<MACHINE2>\\photos and \\\\<MACHINE3>\\photos and \\\\<MACHINE2>\\more');
  });

  it('replaces a SQL instance host that is not this machine', () => {
    expect(r('at OFFICEPC\\SQLEXPRESS')).toBe('at <MACHINE2>\\SQLEXPRESS');
  });

  /**
   * The alias rules fire on "a host name in a UNC path / SQL instance", and
   * `localhost` matches that shape. Replacing it would be pure loss: it names
   * nobody, and "the app could not reach <MACHINE2>" hides the single most
   * useful fact in the line, which is that it was talking to itself.
   */
  it('leaves loopback names alone — they identify nobody and they are useful', () => {
    expect(r('\\\\localhost\\share')).toBe('\\\\localhost\\share');
    expect(r('at localhost\\SQLEXPRESS')).toBe('at localhost\\SQLEXPRESS');
    expect(r('at 127.0.0.1\\SQLEXPRESS')).toBe('at 127.0.0.1\\SQLEXPRESS');
  });

  it('leaves loopback alone in a connection string too', () => {
    // One assertion per rule that could alias a host. The connection-string
    // rule is a separate code path from the UNC and instance rules above,
    // and a mutation proved the exemption there was untested.
    expect(r('Server=localhost;Database=CoinInventory;')).toBe('Server=localhost;Database=CoinInventory;');
    expect(r('Data Source=127.0.0.1,1433;')).toBe('Data Source=127.0.0.1,1433;');
  });
});

// Secrets

describe('secrets', () => {
  it('blanks a password in a connection string, and aliases the host', () => {
    expect(r('Server=OFFICEPC;Database=CoinInventory;User Id=sa;Password=hunter2;'))
      .toBe('Server=<MACHINE2>;Database=CoinInventory;User Id=<REDACTED>;Password=<REDACTED>;');
  });

  /**
   * FOUND ON THE REAL LOG, not imagined. `HOMEPC\SQLEXPRESS` was already
   * caught by the SQL-instance rule, but the plain `Server=HOMEPC;` form
   * — no named instance — went through untouched. It is not this machine,
   * so the bare-machine-name rule does not cover it either.
   */
  it('aliases the host in a bare Server= with no instance name', () => {
    expect(r('Server=HOMEPC;Database=CoinInventory;')).toBe('Server=<MACHINE2>;Database=CoinInventory;');
  });

  it('aliases Data Source= too, keeping a tcp: prefix and a port', () => {
    expect(r('Data Source=tcp:OFFICEPC,1433;')).toBe('Data Source=tcp:<MACHINE2>,1433;');
  });

  /**
   * `Address`, `Addr` and `Network Address` are all real mssql
   * connection-string synonyms for `Server`. Covered explicitly because an
   * alternative in a regex that no test exercises is a rule nobody can tell
   * is broken.
   */
  it('aliases the other connection-string spellings of "host"', () => {
    expect(r('Address=OFFICEPC;')).toBe('Address=<MACHINE2>;');
    expect(r('Addr=OFFICEPC;')).toBe('Addr=<MACHINE2>;');
    expect(r('Network Address=OFFICEPC;')).toBe('Network Address=<MACHINE2>;');
  });

  it('leaves the database name alone — it is not a host and it is useful', () => {
    expect(r('Database=CoinInventory;')).toBe('Database=CoinInventory;');
  });

  it('blanks pwd= as well, which is what mssql actually emits', () => {
    expect(r('pwd=s3cr3t;')).toBe('pwd=<REDACTED>;');
  });

  it('blanks api keys and tokens whatever they are called', () => {
    expect(r('api_key: abc123def')).toBe('api_key: <REDACTED>');
    expect(r('access-token=zzzz9999')).toBe('access-token=<REDACTED>');
    expect(r('client_secret="shhh"')).toBe('client_secret=<REDACTED>');
  });

  it('blanks a bearer token in a header dump', () => {
    expect(r('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .toContain('<REDACTED>');
    expect(r('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  /**
   * ADDED AFTER A MUTATION SURVIVED. Disabling the dedicated
   * `Authorization:` rule left every existing test green, because the Bearer
   * rule happened to cover the one example they used. It does not cover
   * this one: `Basic` credentials are a bare base64 blob with no keyword to
   * key off, so without the Authorization rule the whole header survives.
   */
  it('blanks a Basic authorization header, where there is no "Bearer" to key off', () => {
    expect(r('Authorization: Basic ZGF2ZTpsZXRtZWlu')).toBe('Authorization: <REDACTED>');
  });

  it('blanks an authorization value of any shape, to end of line', () => {
    expect(r('authorization=abc def ghi')).toBe('authorization=<REDACTED>');
  });

  it('blanks credentials embedded in a URL', () => {
    expect(r('https://dave:letmein@example.com/x'))
      .toBe('https://<REDACTED>@example.com/x');
  });

  it('blanks an email address', () => {
    expect(r('contact dave.smith+coins@example.co.uk about it'))
      .toBe('contact <EMAIL> about it');
  });

  it('does not blank an ordinary word that merely ends in "pass"', () => {
    expect(r('the bypass worked')).toBe('the bypass worked');
  });
});

// The receipt — "tell the user what was replaced"

describe('the receipt', () => {
  it('counts each placeholder and explains it in plain words', () => {
    const { receipt } = redact(
      'C:/Users/devuser/a\nC:/Users/devuser/b\nMYSERVER\\SQLEXPRESS\nPassword=x;',
      IDENTITY
    );

    const user = receipt.find(e => e.placeholder === '<USER>');
    expect(user).toBeDefined();
    expect(user!.occurrences).toBe(2);
    expect(user!.what).toMatch(/user name/i);

    expect(receipt.find(e => e.placeholder === '<MACHINE>')!.occurrences).toBe(1);
    expect(receipt.find(e => e.placeholder === '<REDACTED>')!.occurrences).toBe(1);
  });

  it('says nothing when nothing was replaced', () => {
    expect(redact('a perfectly ordinary line', IDENTITY).receipt).toEqual([]);
  });

  /**
   * THE RECEIPT IS PART OF THE REPORT. A receipt that said
   * "replaced 'devuser' 4 times" would hand over the very thing it claims to
   * have removed — a mistake that is extremely easy to make and completely
   * invisible until somebody reads a published issue.
   */
  it('never names the value it replaced', () => {
    const { receipt } = redact('C:/Users/devuser/x MYSERVER Password=hunter2;', IDENTITY);
    const asText = JSON.stringify(receipt);
    expect(asText).not.toContain('devuser');
    expect(asText).not.toContain('MYSERVER');
    expect(asText).not.toContain('hunter2');
  });

  it('describes every placeholder it can produce', () => {
    for (const p of ['<USER>', '<USER2>', '<MACHINE>', '<MACHINE3>', '<REDACTED>', '<EMAIL>']) {
      expect(describePlaceholder(p).length).toBeGreaterThan(0);
    }
  });
});

// A redactor shared across several pieces of one report

describe('createRedactor — one allocation table for a whole bundle', () => {
  it('keeps placeholders consistent across separate calls', () => {
    const redactor = createRedactor(IDENTITY);

    const a = redactor.apply('C:\\Users\\alice\\one');
    const b = redactor.apply('C:\\Users\\bob\\two');
    const c = redactor.apply('C:\\Users\\alice\\three');

    expect(a).toContain('<USER2>');
    expect(b).toContain('<USER3>');
    expect(c).toContain('<USER2>');   // alice is still USER2 three calls later
  });

  it('accumulates one receipt over every call', () => {
    const redactor = createRedactor(IDENTITY);
    redactor.apply('C:/Users/devuser/a');
    redactor.apply('C:/Users/devuser/b');

    expect(redactor.receipt().find(e => e.placeholder === '<USER>')!.occurrences).toBe(2);
  });

  it('handles an empty string and a huge string without throwing', () => {
    const redactor = createRedactor(IDENTITY);
    expect(redactor.apply('')).toBe('');
    expect(redactor.apply('x'.repeat(200_000))).toHaveLength(200_000);
  });
});

// *** THE CANARIES ***

describe('canary: a seeded marker must not survive into the report', () => {
  /**
   * One marker, planted in every channel a secret can reach the report
   * through. If ANY of these paths is unredacted, this string shows up and
   * the test fails — including paths nobody thought to write a rule for,
   * because the assertion is "the marker is absent", not "rule N fired".
   */
  const CANARY = 'CANARYLEAK7391';

  const identity = {
    username: `user${CANARY}`,
    machineName: `pc${CANARY}`,
    homeDir: `C:\\Users\\user${CANARY}`
  };

  const report = [
    `Node version: v24.0.0`,
    `Home folder: C:\\Users\\user${CANARY}\\AppData\\Local\\CoinInventory`,
    `Photo library: \\\\pc${CANARY}\\Coin Pictures\\1881-S.jpg`,
    `Attached file: statement-user${CANARY}.qif`,
    `Connecting to SQL Server at pc${CANARY}\\SQLEXPRESS/CoinInventory`,
    `Server=pc${CANARY};Database=CoinInventory;User Id=sa;Password=${CANARY};`,
    `  at formatDate (C:/Users/user${CANARY}/source/dev/server/server.ts:130:12)`,
    `Signed in as user${CANARY}@example.com`,
    `Authorization: Bearer ${CANARY}aaaaaaaa`
  ].join('\n');

  const result = redact(report, identity);

  it('does not appear in the redacted text', () => {
    expect(result.text).not.toContain(CANARY);
  });

  it('does not appear in the receipt', () => {
    expect(JSON.stringify(result.receipt)).not.toContain(CANARY);
  });

  it('does not appear in a lower-cased or upper-cased form either', () => {
    expect(result.text.toUpperCase()).not.toContain(CANARY.toUpperCase());
  });

  it('still leaves a report worth reading', () => {
    // Over-redaction is also a failure: a bundle of nothing but <REDACTED>
    // cannot be debugged. The structural parts must survive.
    expect(result.text).toContain('Node version: v24.0.0');
    expect(result.text).toContain('SQLEXPRESS');
    expect(result.text).toContain('server.ts:130:12');
    expect(result.text).toContain('Coin Pictures');
  });

  it('the canary in a FILE NAME is caught too', () => {
    // Attachment and photo file names are part of the report body. A rule set
    // that only looked at folder segments would miss this one.
    const out = redact(`Attached file: statement-${CANARY}.qif`, {
      username: CANARY,
      machineName: 'PC'
    }).text;
    expect(out).not.toContain(CANARY);
  });
});
