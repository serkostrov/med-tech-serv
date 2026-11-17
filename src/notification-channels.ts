/**
 * Каналы уведомлений по сотруднику (ТЗ, блок 5): какие события приходят на почту, какие в Telegram.
 * Хранится в public.notification_preferences (сотрудник × событие × канал). Нет строки — включено:
 * так было с первого дня, и рассылка (load_email_event_plan, load_telegram_event_plan) читает так же.
 */

export type NotificationChannelCode = "email" | "telegram";

export const NOTIFICATION_CHANNEL_COLUMNS: ReadonlyArray<{ readonly code: NotificationChannelCode; readonly label: string }> = [
  { code: "email", label: "Почта" },
  { code: "telegram", label: "Telegram" }
];

export interface NotificationEventOption {
  readonly code: string;
  readonly label: string;
  /** Когда приходит: строкой под событием. */
  readonly when: string;
}

/** События рассылки (business_event_catalog), по порядку жизни задачи, складские в конце. */
export const NOTIFICATION_EVENT_OPTIONS: readonly NotificationEventOption[] = [
  { code: "task_application_accepted", label: "Заявка принята", when: "по заявкам, где вы инициатор" },
  { code: "task_engineer_assigned", label: "Инженер назначен", when: "инженеру — его задача; инициатору — кто поедет" },
  { code: "task_engineer_accepted", label: "Инженер принял задачу", when: "координаторам и инициатору" },
  { code: "task_work_completed", label: "Работы завершены", when: "инициатору, когда координатор принял акт" },
  { code: "task_rework_requested", label: "Возврат на доработку", when: "инженеру, с комментарием координатора" },
  { code: "task_overdue", label: "Задача просрочена", when: "руководителям" },
  { code: "stock_reservation_created", label: "Новый резерв запчастей", when: "кладовщикам" },
  { code: "stock_reservation_ready", label: "Запчасти можно забрать", when: "инженеру задачи" }
];

const INITIATOR_EVENTS = ["task_application_accepted", "task_engineer_assigned", "task_engineer_accepted", "task_work_completed"];

/**
 * Какие события вообще приходят сотруднику с этой ролью — как в функциях рассылки (0043, 0029).
 * Остальные строки ему не показываем, чтобы кладовщик не настраивал «Задача просрочена».
 * Неизвестная роль (например, своя роль администратора) видит все события.
 */
const EVENTS_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  engineer: ["task_engineer_assigned", "task_rework_requested", "stock_reservation_ready"],
  warehouse: ["stock_reservation_created"],
  coordinator: INITIATOR_EVENTS,
  initiator: INITIATOR_EVENTS,
  manager: INITIATOR_EVENTS,
  supervisor: [...INITIATOR_EVENTS, "task_overdue"]
};

export function notificationEventsForRole(role: string | undefined): readonly NotificationEventOption[] {
  const codes = role && Object.hasOwn(EVENTS_BY_ROLE, role) ? EVENTS_BY_ROLE[role] : undefined;
  return codes ? NOTIFICATION_EVENT_OPTIONS.filter((item) => codes.includes(item.code)) : NOTIFICATION_EVENT_OPTIONS;
}

export interface NotificationPreferenceRow {
  readonly eventCode: string;
  readonly channel: NotificationChannelCode;
  readonly isEnabled: boolean;
}

export type NotificationPreferenceMatrix = Readonly<Record<string, boolean>>;

export function preferenceKey(eventCode: string, channel: NotificationChannelCode): string {
  return `${eventCode}:${channel}`;
}

/** Галочка: нет строки — включено. */
export function isPreferenceEnabled(matrix: NotificationPreferenceMatrix, eventCode: string, channel: NotificationChannelCode): boolean {
  return matrix[preferenceKey(eventCode, channel)] ?? true;
}

export function preferenceMatrix(rows: readonly NotificationPreferenceRow[]): NotificationPreferenceMatrix {
  const matrix: Record<string, boolean> = {};
  for (const row of rows) matrix[preferenceKey(row.eventCode, row.channel)] = row.isEnabled;
  return matrix;
}

/** Что сохранить: только галочки, которые поменяли относительно загруженного. */
export function changedPreferences(
  initial: NotificationPreferenceMatrix,
  current: NotificationPreferenceMatrix
): readonly NotificationPreferenceRow[] {
  const changed: NotificationPreferenceRow[] = [];
  for (const event of NOTIFICATION_EVENT_OPTIONS) {
    for (const channel of NOTIFICATION_CHANNEL_COLUMNS) {
      const before = isPreferenceEnabled(initial, event.code, channel.code);
      const after = isPreferenceEnabled(current, event.code, channel.code);
      if (before !== after) changed.push({ eventCode: event.code, channel: channel.code, isEnabled: after });
    }
  }
  return changed;
}
