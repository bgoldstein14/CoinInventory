import { ErrorHandler, Injectable, inject } from '@angular/core';
import { LoggingService } from './logging.service';
import { NotificationService } from './notification.service';
import { RecentErrorsService } from './support/recent-errors.service';

/**
 * Angular's global error handler: catches anything thrown anywhere in the
 * app, logs it, remembers it for the problem report, and shows a toast.
 * Registered in app.config.ts.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly logging = inject(LoggingService);
  private readonly notifications = inject(NotificationService);

  /**
   * The in-memory tail that "Help > Report a problem" reads.
   *
   * WHY IT IS NOT ENOUGH TO RELY ON this.logging: LoggingService stops
   * POSTing to the backend for thirty seconds after a failed send, and the
   * backend being unreachable is exactly when the errors worth reporting
   * happen. Without this line the report's "recent errors" section would be
   * reliably empty in the one situation it exists for.
   */
  private readonly recentErrors = inject(RecentErrorsService);

  handleError(error: unknown): void {
    const message = error instanceof Error
      ? error.message
      : 'An unexpected error occurred';

    this.logging.error('Unhandled error', message);

    // Remember it for the problem report. Recorded here rather than inside
    // LoggingService so it survives the backend being down.
    this.recentErrors.record(message, error instanceof Error ? error.stack : undefined);

    this.notifications.showError(message);
  }
}
