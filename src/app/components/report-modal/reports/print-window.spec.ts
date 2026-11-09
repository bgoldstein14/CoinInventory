/**
 * print-window.spec.ts
 *
 * This is the one piece of the report pipeline that touches a browser, so it
 * is written to take its `window.open` as an argument — which makes the two
 * things that actually go wrong testable under Node with no DOM:
 *
 *   - the pop-up is blocked and `open()` answers null, and
 *   - the document is written but nothing ever calls print().
 */
import { describe, expect, it, vi } from 'vitest';
import { PrintTarget, openPrintWindow } from './print-window';

function fakeWindow(): PrintTarget & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    document: {
      open: vi.fn(),
      write: vi.fn((html: string) => written.push(html)),
      close: vi.fn()
    },
    focus: vi.fn(),
    print: vi.fn()
  } as unknown as PrintTarget & { written: string[] };
}

describe('openPrintWindow', () => {
  it('writes the document and asks the browser to print it', () => {
    const target = fakeWindow();
    const result = openPrintWindow('<!DOCTYPE html><html></html>', () => target);

    expect(result).toBe('printed');
    expect(target.written.join('')).toContain('<!DOCTYPE html>');
    expect(target.document.close).toHaveBeenCalled();
    expect(target.print).toHaveBeenCalled();
  });

  it('closes the document BEFORE printing', () => {
    // Printing a stream that is still open gives a blank or half-rendered
    // page in Chromium, which is the print path this app's shell uses too.
    const order: string[] = [];
    const target = fakeWindow();
    (target.document.close as unknown as { mockImplementation: (fn: () => void) => void })
      .mockImplementation(() => order.push('close'));
    (target.print as unknown as { mockImplementation: (fn: () => void) => void })
      .mockImplementation(() => order.push('print'));

    openPrintWindow('<html></html>', () => target);
    expect(order).toEqual(['close', 'print']);
  });

  it('reports a blocked pop-up instead of throwing', () => {
    // window.open() returns null when the browser blocks it. Dereferencing
    // that is a TypeError inside a click handler, which surfaces to the user
    // as a button that does nothing at all.
    expect(openPrintWindow('<html></html>', () => null)).toBe('blocked');
  });

  it('reports a failure rather than letting it escape the click handler', () => {
    expect(openPrintWindow('<html></html>', () => { throw new Error('no'); })).toBe('blocked');
  });
});
