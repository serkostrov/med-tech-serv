/**
 * Кому в журнале уведомлений видно всё, а кому только своё.
 *
 * Правило живёт в базе (миграция 0034): строки журнала отдаются адресату, а целиком
 * журнал — тем, кто ведёт журнал или настраивает письма. Здесь то же правило словами,
 * чтобы экран не просил у базы чужие строки и честно подписывал, что показывает.
 */

/** Права, которые открывают журнал целиком: ведение журнала и настройка писем. */
export const WHOLE_NOTIFICATION_JOURNAL_PERMISSIONS: readonly string[] = ["audit.read", "notification_settings.write"];

/** Видит ли сотрудник весь журнал уведомлений. Иначе — только адресованное ему. */
export function canReadWholeNotificationJournal(permissions: readonly string[] | undefined): boolean {
  return WHOLE_NOTIFICATION_JOURNAL_PERMISSIONS.some((permission) => permissions?.includes(permission) === true);
}

/** Отбор журнала для того, кому весь журнал не положен: письма клиентам и чужие чаты отсекаются. */
export function visibleNotificationJournal<T extends { readonly recipientUserId?: string }>(
  items: readonly T[],
  viewer: { readonly id: string; readonly permissions?: readonly string[] }
): readonly T[] {
  if (canReadWholeNotificationJournal(viewer.permissions)) return items;
  return items.filter((item) => item.recipientUserId === viewer.id);
}
