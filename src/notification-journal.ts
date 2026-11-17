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

/**
 * Что не так с шаблоном письма до сохранения (аудит 17.11, № 50): без темы письмо уйдёт
 * с пустой темой, а поле, которого система не знает, приедет получателю как «{{foo}}».
 * Пусто — шаблон в порядке. Пока список полей не загружен, поля не проверяем.
 */
export function notificationTemplateProblem(input: {
  readonly subject: string;
  readonly body: string;
  readonly allowedVariables: readonly string[];
}): string {
  if (!input.subject.trim()) return "Напишите тему письма: без неё письмо уйдёт с пустой темой";
  if (!input.body.trim()) return "Напишите текст письма";
  if (input.allowedVariables.length === 0) return "";
  const allowed = new Set(input.allowedVariables);
  const used = [...`${input.subject}\n${input.body}`.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/gu)].map((match) => match[1] ?? "");
  const unknown = [...new Set(used.filter((name) => !allowed.has(name)))];
  if (unknown.length === 0) return "";
  return `Таких полей система не знает: ${unknown.map((name) => `{{${name}}}`).join(", ")}. Их получатель увидит как есть. Можно вставить: ${input.allowedVariables.map((name) => `{{${name}}}`).join(", ")}`;
}

