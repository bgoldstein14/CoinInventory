import '@angular/compiler';
import { describe, expect, it, beforeEach } from 'vitest';
import { NotificationToast } from './notification-toast';
import { NotificationService } from '../../services/notification.service';

/**
 * NotificationToast uses constructor injection rather than `inject()`, so the
 * service can be handed over directly — no injection context, and no DOM,
 * which is what makes this testable under Node.
 */
describe('NotificationToast', () => {
  let component: NotificationToast;
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    component = new (NotificationToast as any)(service);
  });

  it('displays notifications from the service', () => {
    service.show('Test notification', 'info');

    const notifications = component.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe('Test notification');
    expect(notifications[0].type).toBe('info');
  });

  it('dismisses a notification when onDismiss is called', () => {
    service.show('Test notification', 'info');
    const id = service.notifications()[0].id;

    component.onDismiss(id);

    expect(service.notifications()).toHaveLength(0);
  });

  it('displays multiple notifications stacked', () => {
    service.show('First', 'info');
    service.show('Second', 'warning');
    service.show('Third', 'error');

    expect(component.notifications()).toHaveLength(3);
  });

  it('uses the correct CSS class for info notifications', () => {
    service.show('Info message', 'info');
    const cssClass = component.notificationClass(service.notifications()[0]);
    expect(cssClass).toContain('notification--info');
  });

  it('uses the correct CSS class for warning notifications', () => {
    service.show('Warning message', 'warning');
    const cssClass = component.notificationClass(service.notifications()[0]);
    expect(cssClass).toContain('notification--warning');
  });

  it('uses the correct CSS class for error notifications', () => {
    service.show('Error message', 'error');
    const cssClass = component.notificationClass(service.notifications()[0]);
    expect(cssClass).toContain('notification--error');
  });
});
