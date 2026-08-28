import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { LogEntry } from '../types/coin.model';

/**
 * LoggingService provides centralized logging for the application.
 *
 * Logs are sent to the backend at /api/log for persistence and monitoring.
 * If the backend is unavailable, logs fall back to console only.
 * All logs are also written to the browser console for immediate visibility.
 *
 * Usage:
 *   constructor(private logger: LoggingService) {}
 *   this.logger.info('User clicked save button');
 *   this.logger.warn('API response took longer than expected');
 *   this.logger.error('Failed to save coin', JSON.stringify(error));
 */
@Injectable({ providedIn: 'root' })
export class LoggingService {
  // Flag to track whether the backend logging endpoint is available
  // Set to false after first HTTP error to avoid repeated failed requests
  private backendAvailable = true;

  constructor(private http: HttpClient) {}

  /**
   * Log an informational message.
   * Use for general operation tracking and debugging.
   *
   * @param message - The message to log
   * @param details - Optional additional details for context
   */
  info(message: string, details?: string): void {
    this.log('INFO', message, details);
  }

  /**
   * Log a warning message.
   * Use for non-critical issues that should be investigated.
   *
   * @param message - The warning message to log
   * @param details - Optional additional details for context
   */
  warn(message: string, details?: string): void {
    this.log('WARN', message, details);
  }

  /**
   * Log an error message.
   * Use for critical failures that impact functionality.
   *
   * @param message - The error message to log
   * @param details - Optional additional details (stack trace, error object, etc.)
   */
  error(message: string, details?: string): void {
    this.log('ERROR', message, details);
  }

  /**
   * Internal method that handles the actual logging logic.
   * Sends logs to both the backend API and browser console.
   *
   * @param level - Log severity level
   * @param message - Log message
   * @param details - Optional additional details
   */
  private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: string): void {
    // Always log to console for immediate visibility during development
    const consoleMsg = details ? `[${level}] ${message} | ${details}` : `[${level}] ${message}`;

    if (level === 'ERROR') {
      console.error(consoleMsg);
    } else if (level === 'WARN') {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    // Send to backend if available
    if (this.backendAvailable) {
      const logEntry: Partial<LogEntry> = {
        level,
        message,
        details,
        source: 'frontend',
        timestamp: new Date().toISOString()
      };

      // Use subscribe to actually trigger the HTTP request
      // HTTP calls are cold observables and won't execute without subscription
      this.http.post('/api/log', logEntry).subscribe({
        error: (err) => {
          // Backend is unavailable - disable future backend logging attempts
          this.backendAvailable = false;
          console.warn('[LoggingService] Backend logging unavailable, falling back to console only', err);
        }
      });
    }
  }
}
