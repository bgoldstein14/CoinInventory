/**
 * Tests the request bodies SupportService sends. The "Include recent log"
 * choice must be sent explicitly (the server defaults to including it), and
 * no attachments or log lines are sent from the browser. HttpClient is stubbed.
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

  /** Omitting the field would leave the server on its default (ticked). */
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

  /** No attachments, base64 or archive. */
  it('sends nothing else at all', async () => {
    const { service, posts } = createService();

    await service.saveReport('x', true);

    expect(Object.keys(posts[0].body).sort()).toEqual(['includeLog', 'markdown']);
  });
});
