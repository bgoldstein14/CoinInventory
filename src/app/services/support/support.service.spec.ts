/**
 * support.service.spec.ts — what actually goes on the wire.
 *
 * WHY THIS FILE EXISTS
 * The dialog has tests proving it passes the user's "Include recent log"
 * choice to this service. Nothing proved the service then put it in the
 * request. That is a one-line gap with a silent failure mode: the checkbox
 * would appear to work, the summary would change, and the server would use
 * its default — which is TICKED — so a user who turned the log off would get
 * a log file anyway and the dialog would be the last to know.
 *
 * It also pins the shape of what is NOT sent. There is no attachment array,
 * no base64, and no log lines from the browser: the server reads the log
 * itself, so the unredacted one never passes through here.
 *
 * HttpClient is a stub rather than a real backend — the suite runs under Node
 * with no jsdom, and what is being checked is the body, not the transport.
 */

import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { HttpClient } from '@angular/common/http';

import { SupportService } from './support.service';

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

function createService(): { service: SupportService; posts: Posted[] } {
  const posts: Posted[] = [];
  const http = {
    get: vi.fn(() => of({})),
    post: vi.fn((url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
      return of({});
    })
  } as unknown as HttpClient;

  return { service: new SupportService(http), posts };
}

describe('preview', () => {
  it('puts the log choice in the request, ticked', async () => {
    const { service, posts } = createService();

    await service.preview({ userDescription: 'it broke', includeLog: true });

    expect(posts[0].url).toContain('/api/support/preview');
    expect(posts[0].body['includeLog']).toBe(true);
  });

  /**
   * THE ONE THAT MATTERS. Omitting the field here would leave the server on
   * its default — ticked — and silently overrule the user.
   */
  it('puts the log choice in the request, unticked', async () => {
    const { service, posts } = createService();

    await service.preview({ includeLog: false });

    expect(posts[0].body['includeLog']).toBe(false);
  });

  it('sends no log lines of its own — the server reads them', async () => {
    const { service, posts } = createService();

    await service.preview({ includeLog: true });

    expect(Object.keys(posts[0].body).sort())
      .toEqual(['clientErrors', 'includeLog', 'userDescription']);
  });
});

describe('saveReport', () => {
  it('sends the markdown and the log choice', async () => {
    const { service, posts } = createService();

    await service.saveReport('## Problem report\n', true);

    expect(posts[0].url).toContain('/api/support/report');
    expect(posts[0].body['markdown']).toBe('## Problem report\n');
    expect(posts[0].body['includeLog']).toBe(true);
  });

  it('carries an unticked box through to the writer', async () => {
    const { service, posts } = createService();

    await service.saveReport('x', false);

    expect(posts[0].body['includeLog']).toBe(false);
  });

  /** No attachments, no base64, no archive. All three were removed on purpose. */
  it('sends nothing else at all', async () => {
    const { service, posts } = createService();

    await service.saveReport('x', true);

    expect(Object.keys(posts[0].body).sort()).toEqual(['includeLog', 'markdown']);
  });
});
