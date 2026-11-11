// Общие правила уведомлений (перенесены из packages/domain прежней версии проекта).

export type DomainId = string & { readonly __brand: "DomainId" };
export type IsoDateTime = string & { readonly __brand: "IsoDateTime" };

const EMAIL_ADDRESS_MAX_LENGTH = 254;

export function isValidEmailAddress(value: string): boolean {
  return value.length <= EMAIL_ADDRESS_MAX_LENGTH
    && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(value)
    && !/[\r\n]/u.test(value);
}

export function toDomainId(value: string): DomainId {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("Domain id must not be empty");
  return normalized as DomainId;
}

export function toIsoDateTime(value: string | Date): IsoDateTime {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid ISO date-time");
  return date.toISOString() as IsoDateTime;
}

/** Стабильные коды каналов; наличие кода не означает, что канал включён. */
export const NOTIFICATION_CHANNEL_CODES = ["email", "telegram", "max", "sms"] as const;
export type NotificationChannelCode = (typeof NOTIFICATION_CHANNEL_CODES)[number];

/** Каталог бизнес-событий совпадает с таблицей business_event_catalog. */
export const BUSINESS_EVENT_CATALOG = {
  task_application_accepted: { name: "Заявка принята", aggregateType: "task", version: 1 },
  task_engineer_assigned: { name: "Инженер назначен", aggregateType: "task", version: 1 },
  task_engineer_accepted: { name: "Инженер принял задачу", aggregateType: "task", version: 1 },
  task_work_completed: { name: "Работы завершены", aggregateType: "task", version: 1 },
  task_rework_requested: { name: "Задача возвращена на доработку", aggregateType: "task", version: 1 },
  task_overdue: { name: "Задача просрочена", aggregateType: "task", version: 1 },
  stock_reservation_created: { name: "Создан резерв запчастей", aggregateType: "stock_reservation", version: 1 },
  stock_reservation_ready: { name: "Запчасти можно забрать", aggregateType: "stock_reservation", version: 1 }
} as const;

export type BusinessEventCode = keyof typeof BUSINESS_EVENT_CATALOG;
export type BusinessAggregateType = (typeof BUSINESS_EVENT_CATALOG)[BusinessEventCode]["aggregateType"];

export interface BusinessEvent<Payload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly id: DomainId;
  readonly idempotencyKey: string;
  readonly eventCode: BusinessEventCode;
  readonly eventVersion: number;
  readonly aggregateType: BusinessAggregateType;
  readonly aggregateId: DomainId;
  readonly occurredAt: IsoDateTime;
  readonly payload: Payload;
}

export function assertBusinessEvent(event: BusinessEvent): void {
  const catalogEntry = BUSINESS_EVENT_CATALOG[event.eventCode];
  if (!catalogEntry) throw new Error(`Неизвестное бизнес-событие: ${String(event.eventCode)}`);
  if (event.eventVersion !== catalogEntry.version) {
    throw new Error(`Неподдерживаемая версия события ${event.eventCode}: ${event.eventVersion}`);
  }
  if (event.aggregateType !== catalogEntry.aggregateType) {
    throw new Error(`Событие ${event.eventCode} не относится к агрегату ${event.aggregateType}`);
  }
  if (!event.idempotencyKey.trim()) throw new Error("У бизнес-события отсутствует idempotency key");
}

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu;

export interface NotificationTemplateText {
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly allowedVariables: readonly string[];
}

export function assertNotificationTemplate(template: NotificationTemplateText): void {
  if (template.subjectTemplate.length > 300 || /[\r\n]/u.test(template.subjectTemplate)) {
    throw new Error("Тема уведомления должна быть одной строкой длиной до 300 символов");
  }
  if (!template.bodyTemplate.trim() || template.bodyTemplate.length > 10_000) {
    throw new Error("Текст уведомления должен содержать от 1 до 10000 символов");
  }
  const allowed = new Set(template.allowedVariables);
  const combined = `${template.subjectTemplate}\n${template.bodyTemplate}`;
  for (const match of combined.matchAll(TEMPLATE_TOKEN)) {
    const variable = match[1];
    if (!variable || !allowed.has(variable)) {
      throw new Error(`Переменная шаблона {{${variable ?? ""}}} недоступна для этого события`);
    }
  }
  const withoutTokens = combined.replace(TEMPLATE_TOKEN, "");
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
    throw new Error("Переменные шаблона должны иметь вид {{имяПеременной}}");
  }
}

export function renderNotificationTemplate(
  template: NotificationTemplateText,
  variables: Readonly<Record<string, unknown>>
): { readonly subject: string; readonly body: string } {
  assertNotificationTemplate(template);
  const replace = (_token: string, name: string): string => {
    const value = variables[name];
    if (value === undefined || value === null || value === "") return "—";
    return String(value);
  };
  return {
    subject: template.subjectTemplate.replace(TEMPLATE_TOKEN, replace).trim(),
    body: template.bodyTemplate.replace(TEMPLATE_TOKEN, replace).trim()
  };
}
