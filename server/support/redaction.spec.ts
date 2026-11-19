/**
 * Redaction rules. The canary block at the bottom is the key test: one marker
 * is planted in every channel (username, machine name, paths, file names,
 * connection strings) and must not appear anywhere in the output or receipt.
 * Placeholders must also be stable, and distinct for different users.
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
    // Falls back to the home directory's last segment; a wrong guess only over-redacts.
    expect(identity.username).toBe('dev');
  });

  it('ignores blank environment values rather than treating them as a name', () => {
    // A rule built from '' would match everywhere.
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

  /** The same folder must read as the same folder. */
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
    // 'devuser2' is someone else and must not become '<USER>2'.
    expect(r('account devuser2 locked')).toBe('account devuser2 locked');
  });

  /** Very short usernames would match inside ordinary words; the path rule still covers them. */
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

  /** Loopback names identify nobody and show the app was talking to itself. */
  it('leaves loopback names alone — they identify nobody and they are useful', () => {
    expect(r('\\\\localhost\\share')).toBe('\\\\localhost\\share');
    expect(r('at localhost\\SQLEXPRESS')).toBe('at localhost\\SQLEXPRESS');
    expect(r('at 127.0.0.1\\SQLEXPRESS')).toBe('at 127.0.0.1\\SQLEXPRESS');
  });

  it('leaves loopback alone in a connection string too', () => {
    // The connection-string rule is a separate code path from the UNC and instance rules.
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

  /** `Server=HOMEPC;` without an instance name isn't caught by the instance or machine-name rules. */
  it('aliases the host in a bare Server= with no instance name', () => {
    expect(r('Server=HOMEPC;Database=CoinInventory;')).toBe('Server=<MACHINE2>;Database=CoinInventory;');
  });

  it('aliases Data Source= too, keeping a tcp: prefix and a port', () => {
    expect(r('Data Source=tcp:OFFICEPC,1433;')).toBe('Data Source=tcp:<MACHINE2>,1433;');
  });

  /** `Address`, `Addr` and `Network Address` are connection-string synonyms for `Server`. */
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
   * `Basic` credentials have no "Bearer" keyword, so only the dedicated
   * Authorization rule catches them.
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

  /** A receipt that named the value would leak it. */
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

// The canaries

describe('canary: a seeded marker must not survive into the report', () => {
  /**
   * One marker in every channel a secret can reach the report through. The
   * assertion is "the marker is absent", so it also catches paths nobody wrote
   * a rule for.
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
    // Over-redaction is a failure too: the structure must survive.
    expect(result.text).toContain('Node version: v24.0.0');
    expect(result.text).toContain('SQLEXPRESS');
    expect(result.text).toContain('server.ts:130:12');
    expect(result.text).toContain('Coin Pictures');
  });

  it('the canary in a FILE NAME is caught too', () => {
    // File names in the body, not just folder segments.
    const out = redact(`Attached file: statement-${CANARY}.qif`, {
      username: CANARY,
      machineName: 'PC'
    }).text;
    expect(out).not.toContain(CANARY);
  });
});
