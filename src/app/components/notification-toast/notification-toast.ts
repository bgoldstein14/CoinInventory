import { Component, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NotificationService } from '../../services/notification.service';
import { AppNotification } from '../../types/coin.model';

/**
 * NotificationToast component displays stacked toast notifications.
 *
 * This component is typically added to the root app component template:
 *   <app-notification-toast />
 *
 * It subscribes to the NotificationService and renders notifications
 * in a fixed position at the top-right of the screen.
 *
 * Features:
 * - Color-coded by type (blue=info, amber=warning, red=error)
 * - Auto-dismisses info and warning toasts after their duration
 * - Error toasts are sticky and must be manually dismissed with X button
 * - Smooth slide-in/fade-out animations
 * - Stacked layout with proper spacing
 */
@Component({
  selector: 'app-notification-toast',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-toast.html',
  styleUrl: './notification-toast.scss'
})
export class NotificationToast {
  // Inject the notification service to access active notifications
  constructor(private notificationService: NotificationService) {}

  /**
   * Computed signal that provides the current list of notifications.
   * This automatically updates when the notification service's signal changes.
   */
  notifications = computed(() => this.notificationService.notifications());

  /**
   * Dismiss a notification by calling the service's dismiss method.
   * Used by the template's dismiss button click handler.
   *
   * @param id - The unique ID of the notification to dismiss
   */
  dismiss(id: string): void {
    this.notificationService.dismiss(id);
  }

  /**
   * Alias for dismiss() — used by test suite.
   */
  onDismiss(id: string): void {
    this.dismiss(id);
  }

  /**
   * Returns the CSS class string for a notification based on its type.
   * Useful for programmatic class assignment and testing.
   *
   * @param notification - The notification to get the class for
   * @returns CSS class string like 'notification notification--info'
   */
  notificationClass(notification: AppNotification): string {
    return `notification notification--${notification.type}`;
  }
}
