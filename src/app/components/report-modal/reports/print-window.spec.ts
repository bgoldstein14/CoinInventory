/** Tests for openPrintWindow, using a fake window opener. */
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
    // Chromium prints a still-open document as a blank page.
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
    // window.open() returns null when the browser blocks it.
    expect(openPrintWindow('<html></html>', () => null)).toBe('blocked');
  });

  it('reports a failure rather than letting it escape the click handler', () => {
    expect(openPrintWindow('<html></html>', () => { throw new Error('no'); })).toBe('blocked');
  });
});
