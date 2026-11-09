import { Component, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NotificationService } from '../../services/notification.service';
import { AppNotification } from '../../types/coin.model';

/**
 * NotificationToast — stacked toasts, fixed at the top-right. Rendered once,
 * from the root template: `<app-notification-toast />`.
 *
 * Info and warning toasts auto-dismiss after their duration; ERROR toasts are
 * sticky and only go away when the user presses the X, so a failure cannot
 * scroll past unseen.
 */
@Component({
  selector: 'app-notification-toast',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-toast.html',
  styleUrl: './notification-toast.scss'
})
export class NotificationToast {
  constructor(private notificationService: NotificationService) {}

  notifications = computed(() => this.notificationService.notifications());

  dismiss(id: string): void {
    this.notificationService.dismiss(id);
  }

  /** Alias for dismiss() — used by the test suite. */
  onDismiss(id: string): void {
    this.dismiss(id);
  }

  /** e.g. 'notification notification--info'. Exists so the class choice is
   *  assertable without a DOM. */
  notificationClass(notification: AppNotification): string {
    return `notification notification--${notification.type}`;
  }
}
