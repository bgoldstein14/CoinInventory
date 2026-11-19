/*
 * The Help screen. No jsdom, so the template and stylesheet are read as text,
 * with comments stripped first so assertions match markup, not explanations.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The template with comments removed and `&#64;` decoded to `@` (a bare `@`
 * starts an Angular control-flow block, so the handle is written escaped).
 */
function template(): string {
  return readFileSync(join(__dirname, 'help-modal.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&#64;/g, '@');
}

/** The stylesheet with both comment styles removed. */
function styles(): string {
  return readFileSync(join(__dirname, 'help-modal.scss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The body of one top-level rule, e.g. ruleBody('.help-support-note'). */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`);
  const match = styles().match(pattern);
  expect(match, `${selector} is missing from help-modal.scss`).toBeTruthy();
  return match![1];
}

/** A `font-size: 0.72rem` declaration, as a number of rem. */
function fontSizeRem(selector: string): number {
  const match = ruleBody(selector).match(/font-size:\s*([\d.]+)rem/);
  expect(match, `${selector} declares no font-size in rem`).toBeTruthy();
  return Number(match![1]);
}

/** The markup of one element, opening tag through closing tag. */
function element(tag: string, className: string): string {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>[\\s\\S]*?</${tag}>`
  );
  const match = template().match(pattern);
  expect(match, `no <${tag} class="... ${className} ..."> in help-modal.html`).toBeTruthy();
  return match![0];
}

describe('HelpModal — help first, bug form second', () => {
  it('offers "Report a problem", because that is what the help icon used to do', () => {
    /* The help icon must still lead to the problem reporter. */
    expect(template()).toMatch(/\(click\)="reportProblem\(\)"[\s\S]*?>\s*Report a problem\s*</);
  });

  it('puts the guide above the report section, with a rule between them', () => {
    /* The guide comes first, the report section after it. */
    const markup = template();
    const guide = markup.indexOf('The buttons along the top');
    const separator = markup.indexOf('help-separator');
    const report = markup.indexOf('Something not working?');
    const action = markup.indexOf('reportProblem()');

    expect(guide, 'the guide section is missing').toBeGreaterThan(-1);
    expect(separator, 'a rule marks the end of the guide').toBeGreaterThan(guide);
    expect(report, 'and the report section comes after the rule').toBeGreaterThan(separator);
    expect(action).toBeGreaterThan(report);
  });

  it('draws that separator as a real rule with real space around it', () => {
    /* A visible separator with space on both sides. */
    expect(template(), 'an <hr>, not a styled border on the section below')
      .toMatch(/<hr\b[^>]*class="[^"]*\bhelp-separator\b/);

    const rule = ruleBody('.help-separator');
    expect(rule, 'the line has to be drawn').toMatch(/border-top:\s*1px solid #[0-9a-f]{6}/i);
    expect(rule, 'with space above it, beyond the body gap').toMatch(/margin:\s*[\d]+px/);
    expect(ruleBody('.help-report'), 'and space below it too').toMatch(/padding-top:\s*[\d]+px/);
  });

  it('keeps the author block and the support note below everything functional', () => {
    /* Author and support note stay at the very bottom. */
    const markup = template();
    const report = markup.indexOf('reportProblem()');
    const author = markup.indexOf('Author: Bruce Goldstein');
    const note = markup.indexOf('help-support-note');

    expect(report).toBeGreaterThan(-1);
    expect(author).toBeGreaterThan(report);
    expect(note).toBeGreaterThan(author);
  });
});

describe('HelpModal — the author block', () => {
  it('names the author and the ANA number, both of them', () => {
    const about = element('section', 'help-about');

    expect(about).toContain('Author: Bruce Goldstein');
    expect(about).toContain('ANA #: 3124621');
  });

  it('states it plainly, with no byline styling', () => {
    const about = element('section', 'help-about');
    expect(about).not.toMatch(/<h[1-6]\b/);
    expect(fontSizeRem('.help-author')).toBeLessThanOrEqual(0.9);
  });
});

describe('HelpModal — the support note is a footnote, not a pitch', () => {
  it('says the app is free first, and says it without a condition', () => {
    /* "Free" comes before the handle, without conditions. */
    const note = element('p', 'help-support-note');
    const free = note.indexOf('free for everyone');
    const handle = note.indexOf('@bgoldstein14');

    expect(free, 'the note must say the app is free for everyone').toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(-1);
    expect(free, 'free is stated before any mention of money').toBeLessThan(handle);
  });

  it('closes warmly rather than with a shrug', () => {
    const note = element('p', 'help-support-note');

    expect(note, 'the shrug is gone').not.toMatch(/\banyway\b/i);
    expect(note, 'and the reader is still let off, warmly').toMatch(/either way/i);
  });

  it('is set smaller than the smallest explanatory text on the screen', () => {
    /* Smaller than `.hint-text` (0.82rem), so it reads as a footnote. */
    expect(fontSizeRem('.help-support-note')).toBeLessThan(0.82);
  });

  it('is muted, and never in the colours the app uses for things you press', () => {
    const body = ruleBody('.help-support-note');
    const colour = body.match(/color:\s*(#[0-9a-f]{6})/i);

    expect(colour, 'the note declares no colour, so it inherits body text').toBeTruthy();
    // The browns the app's own controls are drawn in.
    expect(['#7a5b35', '#8e5b2d', '#b98748']).not.toContain(colour![1].toLowerCase());
  });

  it('is not a button, a link, or anything else that can be pressed', () => {
    /* The note contains no control at all. */
    const note = element('p', 'help-support-note');

    expect(note).not.toMatch(/<button\b/);
    expect(note).not.toMatch(/<a\b/);
    expect(note).not.toMatch(/\(click\)=/);
  });

  it('carries no emoji and no exhortation', () => {
    const note = element('p', 'help-support-note');

    // Characters outside the BMP plus the dingbat/symbol ranges used by emoji.
    expect(note).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
    expect(note).not.toMatch(/support my work/i);
    expect(note).not.toMatch(/donate/i);
    expect(note).not.toMatch(/!/);
  });

  it('leaves the handle as selectable text so it can be copied', () => {
    /* Plain text, so it must be selectable. */
    expect(element('p', 'help-support-note')).toContain('@bgoldstein14');
    expect(ruleBody('.help-handle')).toMatch(/user-select:\s*text/);
  });
});

describe('HelpModal — the note is never a prompt', () => {
  it('appears on this screen and nowhere else in the application', () => {
    /* The handle appears exactly once in src/, so it is never reused as a prompt. */
    const appRoot = join(__dirname, '..', '..');
    const hits = filesContaining(appRoot, 'bgoldstein14');

    expect(hits).toEqual(['components/help-modal/help-modal.html']);
  });

  it('is reached only from the help icon, not raised by the shell on its own', () => {
    const shell = readFileSync(join(__dirname, '..', '..', 'app.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    const setters = [...shell.matchAll(/showHelpModal\.set\(true\)/g)];
    expect(setters.length, 'exactly one place opens the Help screen').toBe(1);
    expect(shell, 'and nothing opens it on a timer').not.toMatch(
      /setTimeout[\s\S]{0,200}showHelpModal/
    );
  });

  it('is wired to the toolbar icon in the shell', () => {
    const shellTemplate = readFileSync(join(__dirname, '..', '..', 'app.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');

    expect(shellTemplate).toMatch(/\(helpRequested\)="openHelpModal\(\)"/);
    expect(shellTemplate).toMatch(/<app-help-modal[\s\S]*?\/>/);
    expect(shellTemplate).toMatch(/\(reportProblemRequested\)="openSupportModalFromHelp\(\)"/);
  });
});

/** Every file under `root` containing `needle`, as posix-ish relative paths. */
function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else if (/\.(ts|html|scss|json)$/.test(entry) && !entry.endsWith('.spec.ts')) {
        if (readFileSync(full, 'utf8').includes(needle)) found.push(rel);
      }
    }
  };

  walk(root, '');
  return found.sort();
}
