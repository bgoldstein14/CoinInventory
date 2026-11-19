import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { RecentErrorsService } from './support/recent-errors.service';

/**
 * Global error handler: logs anything thrown in the app, records it for the
 * problem report, and shows a toast. Registered in app.config.ts.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly logging = inject(LoggingService);
  private readonly notifications = inject(NotificationService);

  /**
   * In-memory list of recent errors for "Help > Report a problem". Kept separately
   * from LoggingService, which pauses backend sends after a failure, so errors
   * are still captured while the backend is unreachable.
   */
  private readonly recentErrors = inject(RecentErrorsService);

  handleError(error: unknown): void {
    const message = error instanceof Error
      ? error.message
      : 'An unexpected error occurred';

    this.logging.error('Unhandled error', message);

    this.recentErrors.record(message, error instanceof Error ? error.stack : undefined);

    this.notifications.showError(message);
  }
}
