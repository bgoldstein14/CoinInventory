import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { LoggingService } from './logging.service';
import { resolveApiBaseUrl } from './http-utils';
import { of, throwError } from 'rxjs';

/**
 * LoggingService uses constructor injection, so it is created with `new`
 * and a mock HttpClient.
 */

/**
 * The service posts to an absolute URL. Under Vitest there is no `window`,
 * so resolveApiBaseUrl() returns http://localhost:3000.
 */
const LOG_URL = `${resolveApiBaseUrl()}/api/log`;
describe('LoggingService', () => {
  let service: LoggingService;
  let mockHttpClient: any;

  beforeEach(() => {
    mockHttpClient = {
      post: vi.fn(() => of({})),
    };

    service = new (LoggingService as any)(mockHttpClient);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs INFO messages to the backend via HTTP POST', () => {
    service.info('Test info message', 'Additional details');

    expect(mockHttpClient.post).toHaveBeenCalledWith(
      LOG_URL,
      expect.objectContaining({
        level: 'INFO',
        message: 'Test info message',
        details: 'Additional details',
        source: 'frontend',
      })
    );
  });

  it('logs WARN messages to the backend via HTTP POST', () => {
    service.warn('Test warning message');

    expect(mockHttpClient.post).toHaveBeenCalledWith(
      LOG_URL,
      expect.objectContaining({
        level: 'WARN',
        message: 'Test warning message',
        source: 'frontend',
      })
    );
  });

  it('logs ERROR messages to the backend via HTTP POST', () => {
    service.error('Test error message', 'Stack trace details');

    expect(mockHttpClient.post).toHaveBeenCalledWith(
      LOG_URL,
      expect.objectContaining({
        level: 'ERROR',
        message: 'Test error message',
        details: 'Stack trace details',
        source: 'frontend',
      })
    );
  });

  it('includes a timestamp in ISO 8601 format', () => {
    const beforeTimestamp = new Date().toISOString();
    service.info('Test message');
    const afterTimestamp = new Date().toISOString();

    const callArgs = mockHttpClient.post.mock.calls[0][1];
    expect(callArgs.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(callArgs.timestamp >= beforeTimestamp).toBe(true);
    expect(callArgs.timestamp <= afterTimestamp).toBe(true);
  });

  it('always writes to console in addition to backend', () => {
    service.info('Test info message');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] Test info message')
    );
  });

  it('falls back to console.warn when HTTP POST fails (WARN)', () => {
    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));

    service.warn('Test warning');

    expect(mockHttpClient.post).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WARN] Test warning')
    );
  });

  it('falls back to console.error when HTTP POST fails (ERROR)', () => {
    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));

    service.error('Test error');

    expect(mockHttpClient.post).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Test error')
    );
  });

  it('handles logging with no details parameter', () => {
    service.info('Message only');

    expect(mockHttpClient.post).toHaveBeenCalledWith(
      LOG_URL,
      expect.objectContaining({
        level: 'INFO',
        message: 'Message only',
        source: 'frontend',
      })
    );
  });

  it('includes details in console output when provided', () => {
    service.info('Main message', 'Extra details');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] Main message | Extra details')
    );
  });

  it('posts to the absolute backend URL, not a relative path', () => {
    service.info('Test message');

    const calledUrl = mockHttpClient.post.mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:3000/api/log');
    // A relative path would post to the Angular dev server instead of the API.
    expect(calledUrl).not.toBe('/api/log');
  });

  // Backoff: a failure suppresses backend posts for 30s, then retries.

  it('stops posting to the backend during the backoff window after a failure', () => {
    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));
    service.info('First message, this one is attempted');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

    service.info('Second message');
    service.info('Third message');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

    // ...but they still reach the console.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[INFO] Third message'));
  });

  it('resumes backend logging once the backoff window expires', () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);

    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));
    service.info('Failing message');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

    // Still suppressed 10 seconds later (backoff is 30s).
    nowSpy.mockReturnValue(realNow + 10_000);
    service.info('Still suppressed');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(1);

    // 31 seconds later the backend is tried again.
    nowSpy.mockReturnValue(realNow + 31_000);
    mockHttpClient.post.mockReturnValue(of({}));
    service.info('Retried message');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(2);
  });

  it('clears the backoff immediately after a successful post', () => {
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow);

    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));
    service.info('Failing message');

    nowSpy.mockReturnValue(realNow + 31_000);
    mockHttpClient.post.mockReturnValue(of({}));
    service.info('Successful message');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(2);

    // After a success the next log is sent immediately.
    service.info('Immediately after success');
    expect(mockHttpClient.post).toHaveBeenCalledTimes(3);
  });
});

