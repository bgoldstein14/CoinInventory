import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    service = new NotificationService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with an empty notification list', () => {
    expect(service.notifications()).toHaveLength(0);
  });

  it('shows an info notification with auto-dismiss', () => {
    service.show('Test message', 'info', true, 3000);

    const notifications = service.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe('Test message');
    expect(notifications[0].type).toBe('info');
    expect(notifications[0].autoDismiss).toBe(true);
    expect(notifications[0].duration).toBe(3000);
  });

  it('shows a warning notification', () => {
    service.showWarning('Warning message');

    const notifications = service.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toBe('Warning message');
  });

  it('shows an error notification', () => {
    service.showError('Error message');

    const notifications = service.notifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toBe('Error message');
  });

  it('dismisses a notification by ID', () => {
    service.show('Test message', 'info');
    const id = service.notifications()[0].id;

    service.dismiss(id);

    expect(service.notifications()).toHaveLength(0);
  });

  it('auto-dismisses notifications after the specified duration', () => {
    service.show('Auto-dismiss message', 'info', true, 5000);

    expect(service.notifications()).toHaveLength(1);

    vi.advanceTimersByTime(5000);

    expect(service.notifications()).toHaveLength(0);
  });

  it('does not auto-dismiss notifications when autoDismiss is false', () => {
    service.show('Manual dismiss only', 'error', false);

    expect(service.notifications()).toHaveLength(1);

    vi.advanceTimersByTime(10000);

    // Errors are dismissed manually only.
    expect(service.notifications()).toHaveLength(1);
  });

  it('supports multiple notifications stacked simultaneously', () => {
    service.show('First notification', 'info');
    service.show('Second notification', 'warning');
    service.show('Third notification', 'error');

    expect(service.notifications()).toHaveLength(3);
    expect(service.notifications()[0].message).toBe('First notification');
    expect(service.notifications()[1].message).toBe('Second notification');
    expect(service.notifications()[2].message).toBe('Third notification');
  });

  it('dismisses only the specified notification when multiple are present', () => {
    service.show('First', 'info');
    service.show('Second', 'warning');
    service.show('Third', 'error');

    const secondId = service.notifications()[1].id;
    service.dismiss(secondId);

    const remaining = service.notifications();
    expect(remaining).toHaveLength(2);
    expect(remaining[0].message).toBe('First');
    expect(remaining[1].message).toBe('Third');
  });

  it('handles auto-dismiss for multiple notifications independently', () => {
    service.show('Short timer', 'info', true, 1000);
    service.show('Long timer', 'warning', true, 5000);

    expect(service.notifications()).toHaveLength(2);

    vi.advanceTimersByTime(1000);
    expect(service.notifications()).toHaveLength(1);
    expect(service.notifications()[0].message).toBe('Long timer');

    vi.advanceTimersByTime(4000);
    expect(service.notifications()).toHaveLength(0);
  });
});
