import { Injectable, signal } from '@angular/core';
import { AppNotification } from '../types/coin.model';

/**
 * User-facing toasts, rendered by the notification-toast component.
 * Info and warning auto-dismiss; errors stay until dismissed, so avoid
 * `showError` for background events that fire without a user action.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  notifications = signal<AppNotification[]>([]);

  showInfo(message: string, duration = 5000): void {
    this.addNotification('info', message, true, duration);
  }

  showWarning(message: string, duration = 8000): void {
    this.addNotification('warning', message, true, duration);
  }

  showError(message: string): void {
    this.addNotification('error', message, false);
  }

  show(message: string, type: 'info' | 'warning' | 'error', autoDismiss?: boolean, duration?: number): void {
    const shouldAutoDismiss = autoDismiss ?? (type !== 'error');
    const defaultDuration = type === 'warning' ? 8000 : 5000;
    this.addNotification(type, message, shouldAutoDismiss, shouldAutoDismiss ? (duration ?? defaultDuration) : undefined);
  }

  dismiss(id: string): void {
    this.notifications.update(notifications =>
      notifications.filter(n => n.id !== id)
    );
  }

  private addNotification(
    type: 'info' | 'warning' | 'error',
    message: string,
    autoDismiss: boolean,
    duration?: number
  ): void {
    const id = crypto.randomUUID();

    const notification: AppNotification = {
      id,
      type,
      message,
      autoDismiss,
      duration
    };

    this.notifications.update(notifications => [...notifications, notification]);

    if (autoDismiss && duration) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }
  }
}
