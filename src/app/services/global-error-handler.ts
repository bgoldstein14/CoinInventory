import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';

/**
 * GlobalErrorHandler
 *
 * Angular's global error handler that catches any unhandled errors
 * thrown throughout the application. Instead of crashing silently,
 * this handler logs the error and notifies the user via a toast message.
 *
 * Usage: Registered in app.config.ts providers array.
 * This is automatically called by Angular when an error occurs.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly logging = inject(LoggingService);
  private readonly notifications = inject(NotificationService);

  /**
   * Handles errors by logging them and showing a user-friendly notification.
   *
   * @param error - The error object (could be Error, string, or any type)
   */
  handleError(error: unknown): void {
    // Extract message safely from the error object
    const message = error instanceof Error
      ? error.message
      : 'An unexpected error occurred';

    // Log the full error with context
    this.logging.error('Unhandled error', message);

    // Show user-friendly toast notification
    this.notifications.showError(message);
  }
}
