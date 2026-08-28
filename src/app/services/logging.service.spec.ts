import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { LoggingService } from './logging.service';
import { of, throwError } from 'rxjs';

/**
 * Tests for LoggingService.
 *
 * This service handles application logging by:
 * - Posting log entries to the backend via HttpClient POST /api/log
 * - Falling back to console.log/warn/error if the HTTP call fails
 * - Supporting INFO, WARN, and ERROR severity levels
 *
 * LoggingService uses constructor injection (not inject()), so it can be
 * created with `new` and the private http field overridden for testing.
 */
describe('LoggingService', () => {
  let service: LoggingService;
  let mockHttpClient: any;

  beforeEach(() => {
    // Mock HttpClient
    mockHttpClient = {
      post: vi.fn(() => of({})),
    };

    // Create service and inject mocked HttpClient via bracket notation
    service = new (LoggingService as any)(mockHttpClient);

    // Spy on console methods to verify fallback behavior
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
      '/api/log',
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
      '/api/log',
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
      '/api/log',
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

    // Console.log is always called with the formatted message string
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] Test info message')
    );
  });

  it('falls back to console.warn when HTTP POST fails (WARN)', () => {
    mockHttpClient.post.mockReturnValue(throwError(() => new Error('Network error')));

    service.warn('Test warning');

    expect(mockHttpClient.post).toHaveBeenCalled();
    // Console.warn is called with the formatted message
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
      '/api/log',
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
});
