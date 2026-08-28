import { Injectable, signal } from '@angular/core';
import { AppNotification } from '../types/coin.model';

/**
 * NotificationService manages user-facing notifications (toasts).
 *
 * Provides methods to show info, warning, and error notifications.
 * Info and warning notifications auto-dismiss after a duration.
 * Error notifications are sticky and must be manually dismissed.
 *
 * Usage:
 *   constructor(private notificationService: NotificationService) {}
 *   this.notificationService.showInfo('Coin saved successfully');
 *   this.notificationService.showWarning('Connection is slow');
 *   this.notificationService.showError('Failed to save coin');
 *
 * The notification-toast component subscribes to the notifications signal
 * and renders them in the UI.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  /**
   * Signal containing the current list of active notifications.
   * Components can subscribe to this signal to display notifications.
   * Signals automatically trigger change detection when updated.
   */
  notifications = signal<AppNotification[]>([]);

  /**
   * Show an informational notification.
   * Auto-dismisses after the specified duration.
   * Use for success messages and non-critical updates.
   *
   * @param message - The message to display
   * @param duration - Auto-dismiss duration in milliseconds (default: 5000ms / 5 seconds)
   */
  showInfo(message: string, duration = 5000): void {
    this.addNotification('info', message, true, duration);
  }

  /**
   * Show a warning notification.
   * Auto-dismisses after the specified duration.
   * Use for non-critical issues that users should be aware of.
   *
   * @param message - The message to display
   * @param duration - Auto-dismiss duration in milliseconds (default: 8000ms / 8 seconds)
   */
  showWarning(message: string, duration = 8000): void {
    this.addNotification('warning', message, true, duration);
  }

  /**
   * Show an error notification.
   * Does NOT auto-dismiss - user must manually dismiss.
   * Use for critical errors that require user attention.
   *
   * @param message - The error message to display
   */
  showError(message: string): void {
    this.addNotification('error', message, false);
  }

  /**
   * Show a notification with explicit type and options.
   * Convenience method for tests and dynamic notification creation.
   *
   * @param message - The message to display
   * @param type - Notification type (info, warning, error)
   * @param autoDismiss - Whether to auto-dismiss (defaults: true for info/warning, false for error)
   * @param duration - Auto-dismiss duration in milliseconds
   */
  show(message: string, type: 'info' | 'warning' | 'error', autoDismiss?: boolean, duration?: number): void {
    const shouldAutoDismiss = autoDismiss ?? (type !== 'error');
    const defaultDuration = type === 'warning' ? 8000 : 5000;
    this.addNotification(type, message, shouldAutoDismiss, shouldAutoDismiss ? (duration ?? defaultDuration) : undefined);
  }

  /**
   * Dismiss a notification by ID.
   * Removes the notification from the active list.
   *
   * @param id - The unique ID of the notification to dismiss
   */
  dismiss(id: string): void {
    // Update the signal by filtering out the dismissed notification
    this.notifications.update(notifications =>
      notifications.filter(n => n.id !== id)
    );
  }

  /**
   * Internal method to create and add a notification.
   * Handles auto-dismiss logic for non-sticky notifications.
   *
   * @param type - Notification type (info, warning, error)
   * @param message - Message to display
   * @param autoDismiss - Whether to auto-dismiss after duration
   * @param duration - Auto-dismiss duration in milliseconds (only used if autoDismiss is true)
   */
  private addNotification(
    type: 'info' | 'warning' | 'error',
    message: string,
    autoDismiss: boolean,
    duration?: number
  ): void {
    // Create a unique ID for this notification using the browser's crypto API
    const id = crypto.randomUUID();

    const notification: AppNotification = {
      id,
      type,
      message,
      autoDismiss,
      duration
    };

    // Add the notification to the signal's array
    this.notifications.update(notifications => [...notifications, notification]);

    // Set up auto-dismiss if enabled
    if (autoDismiss && duration) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }
  }
}
