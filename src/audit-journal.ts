import { TASK_STATUS_LABELS } from "./domain/task-status.js";

/**
 * Журналы: что показывать на экране «Журналы» и как это называть по-русски.
 *
 * Правило доступа живёт в базе: журнал изменений открывает правило строк audit_log,
 * журнал входов — функция login_journal, и то и другое по праву «Просмотр аудита»
 * (audit.read). Здесь то же правило словами, чтобы раздел не показывался тому,
 * кому база всё равно ничего не отдаст.
 */

/** Право, которое открывает оба журнала. */
export const JOURNAL_PERMISSION = "audit.read";

/** Видит ли сотрудник журналы. Инженеру, кладовщику и заказчику они не положены. */
export function canReadJournals(permissions: readonly string[] | undefined): boolean {
  return permissions?.includes(JOURNAL_PERMISSION) === true;
}

/** Что за событие: названия действий из audit_action_for_row и прямых вызовов журнала. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  created: "Создано",
  updated: "Изменено",
  deleted: "Удалено",
  status_changed: "Статус изменён",
  status_transition: "Переход статуса",
  task_closure_accepted: "Закрытие принято"
};

/** Объект события: контур сущности из audit_entity_type_for_table. */
const ENTITY_LABELS: Readonly<Record<string, string>> = {
  task: "Задача",
  equipment: "Прибор",
  invoice: "Счёт",
  warehouse: "Склад",
  integration: "Уведомления и обмен",
  reference: "Справочник",
  user: "Сотрудник",
  audit: "Журнал"
};

/** Где именно внутри объекта была правка: таблица из metadata события. */
const TABLE_LABELS: Readonly<Record<string, string>> = {
  tasks: "Карточка задачи",
  task_status_history: "История статусов задачи",
  task_assignments: "Назначения инженеров",
  task_closures: "Результат работ",
  task_parts: "Запчасти задачи",
  maintenance_plans: "План ТО",
  equipment: "Паспорт прибора",
  equipment_site_history: "История мест установки",
  equipment_payer_history: "История плательщиков",
  equipment_meter_readings: "Показания счётчика",
  equipment_history: "История прибора",
  invoices: "Счёт",
  invoice_items: "Позиции счёта",
  invoice_tasks: "Задачи счёта",
  invoice_adjustments: "Корректировки счёта",
  invoice_status_history: "История статусов счёта",
  parts: "Запчасти",
  part_aliases: "Названия запчастей",
  stock_lots: "Партии на складе",
  stock_reservations: "Резервы",
  stock_reservation_history: "История резервов",
  stock_movements: "Движения склада",
  contracts: "Договоры",
  contract_equipment: "Приборы договора",
  contract_parts: "Запчасти договора",
  price_list: "Прайс",
  quotes: "Коммерческие предложения",
  quote_items: "Позиции предложения",
  notifications: "Журнал уведомлений",
  notification_templates: "Шаблоны писем",
  notification_preferences: "Настройки уведомлений",
  mail_messages: "Входящая почта",
  integration_messages: "Обмен с внешними системами",
  integration_outbox: "Очередь обмена",
  users: "Сотрудники",
  permissions: "Права",
  role_permissions: "Права ролей",
  organizations: "Организации",
  sites: "Площадки",
  site_contacts: "Контакты площадок",
  payers: "Плательщики",
  manufacturers: "Производители",
  equipment_models: "Модели приборов",
  guarantee_categories: "Категории гарантии",
  equipment_statuses: "Статусы приборов",
  work_types: "Виды работ",
  task_statuses: "Статусы задач",
  task_status_transitions: "Переходы статусов",
  task_reasons: "Причины обращения",
  files: "Файлы"
};

/** Поля, которые чаще всего меняют: в журнале они должны читаться, а не угадываться. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "Название",
  number: "Номер",
  status: "Статус",
  status_code: "Статус",
  priority: "Приоритет",
  notes: "Заметки",
  description: "Описание",
  work_description: "Что сделано",
  work_type_code: "Вид работ",
  work_modifier: "Особые условия работ",
  engineer_id: "Инженер",
  site_id: "Площадка",
  payer_id: "Плательщик",
  equipment_id: "Прибор",
  task_id: "Задача",
  organization_id: "Организация",
  contact_id: "Контакт",
  initiator_contact_id: "Кто обратился",
  initiator_name: "Кто обратился",
  deadline_from: "Срок с",
  deadline_to: "Срок по",
  visit_date: "Дата выезда",
  call_date: "Дата вызова",
  closed_at: "Закрыта",
  serial_number: "Серийный номер",
  model_id: "Модель",
  manufacturer_id: "Производитель",
  current_site_id: "Место установки",
  current_payer_id: "Плательщик прибора",
  guarantee_category_id: "Категория гарантии",
  commissioned_at: "Введён в эксплуатацию",
  name: "Название",
  full_name: "Имя",
  email: "E-mail",
  phone: "Телефон",
  role: "Роль",
  access_role_key: "Роль доступа",
  is_active: "Работает",
  permission_code: "Право",
  valid_from: "Действует с",
  valid_to: "Действует по",
  quantity: "Количество",
  condition: "Состояние",
  article_number: "Артикул",
  part_id: "Запчасть",
  reason: "Причина",
  correction_reason: "Причина корректировки",
  comment: "Комментарий",
  telegram_chat_id: "Номер чата Telegram",
  updated_by: "Кто изменил",
  created_by: "Кто создал",
  // Деньги в журнале есть только у счетов (0019) и только с правом на финансы.
  total_amount: "Сумма счёта",
  labor_amount: "Стоимость работ",
  parts_amount: "Стоимость запчастей",
  adjustment_amount: "Корректировка суммы",
  unit_price: "Цена за единицу",
  amount: "Сумма",
  closure_verified: "Закрытие принято",
  closureVerified: "Закрытие принято",
  verificationComment: "Комментарий проверки"
};

/** Служебные поля снимка, которые на экране только мешают. */
const HIDDEN_FIELDS: readonly string[] = ["id", "created_at", "updated_at", "search_vector", "board_position"];

/**
 * Статусы в снимке лежат кодами. Коды повторяются у разных объектов и значат разное
 * («issued» у счёта — выставлен, у резерва — выдан), поэтому переводим их по объекту
 * события, а незнакомый код оставляем как есть.
 */
const STATUS_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  task: TASK_STATUS_LABELS,
  invoice: { draft: "Черновик", issued: "Выставлен", transferred_to_1c: "Передан в 1С", cancelled: "Отменён" },
  integration: {
    queued: "В очереди", sending: "Отправка начата", sent: "Отправлено",
    delivered: "Доставлено", failed: "Ошибка", cancelled: "Отменено"
  },
  warehouse: {
    created: "Создан", warehouse_notified: "Склад уведомлён", issued: "Выдан",
    installed: "Установлен", returned: "Возвращён", cancelled: "Отменён"
  }
};

const STATUS_FIELDS: readonly string[] = ["status", "status_code", "from_status", "to_status"];

export interface AuditJournalEvent {
  readonly id: number;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorUserId?: string;
  readonly actorName?: string;
  readonly action: string;
  readonly outcome: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly tableName?: string;
  readonly changedFields: readonly string[];
  readonly beforeData?: Readonly<Record<string, unknown>>;
  readonly afterData?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly moneyHidden: boolean;
  readonly ipAddress?: string;
}

export interface AuditJournalPage {
  readonly items: readonly AuditJournalEvent[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface LoginJournalEntry {
  readonly id: string;
  /** gotrue — запись службы входа, app — запись CRM о неудачной попытке. */
  readonly source: "gotrue" | "app";
  readonly occurredAt: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly login?: string;
  readonly ipAddress?: string;
  readonly success: boolean;
  readonly failureReason?: string;
}

export interface LoginJournalPage {
  readonly items: readonly LoginJournalEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Нашёлся ли журнал службы входа: без него удачные входы показать негде. */
  readonly successSourceAvailable: boolean;
}

/** Действие события по-русски. Незнакомый код показываем как есть, а не «неизвестно». */
export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * Коды действий, чьё русское название похоже на строку поиска. В журнале лежат коды
 * (updated), а на экране написано «Изменено»: без этого поиск по тому, что человек
 * видит, не находил бы ничего.
 */
export function auditActionCodesForSearch(search: string): readonly string[] {
  const needle = search.trim().toLocaleLowerCase("ru-RU");
  // Одна-две буквы входят почти в каждое название: по ним нашёлся бы весь журнал,
  // и человек решил бы, что фильтр не сработал. Ищем действие от трёх знаков.
  if (needle.length < 3) return [];
  return Object.entries(ACTION_LABELS)
    .filter(([code, label]) => label.toLocaleLowerCase("ru-RU").includes(needle) || code.includes(needle))
    .map(([code]) => code);
}

/** Объект события по-русски. */
export function auditEntityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

/** Где была правка: по таблице события, иначе по объекту. */
export function auditPlaceLabel(event: Pick<AuditJournalEvent, "entityType" | "tableName">): string {
  const byTable = event.tableName ? TABLE_LABELS[event.tableName] : undefined;
  return byTable ?? auditEntityLabel(event.entityType);
}

/** Название поля по-русски; незнакомое поле показываем его собственным именем. */
export function auditFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** Кто сделал: имя сотрудника, а без него — служба или обращение без входа. */
export function auditActorLabel(event: Pick<AuditJournalEvent, "actorName" | "actorType">): string {
  if (event.actorName) return event.actorName;
  if (event.actorType === "system") return "Система";
  if (event.actorType === "anonymous") return "Без входа";
  return "Сотрудник удалён из CRM";
}

/** Значение поля в журнале одной строкой. Статусы показываем словами того объекта, у которого они стоят. */
export function auditValueText(value: unknown, field?: string, entityType?: string): string {
  if (value === null || value === undefined || value === "") return "не задано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (field && entityType && STATUS_FIELDS.includes(field)) {
      const label = STATUS_LABELS[entityType]?.[value];
      if (label) return label;
    }
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return JSON.stringify(value);
}

export interface AuditChangeLine {
  readonly field: string;
  readonly label: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Как изменилось: по полям из changed_fields.
 *
 * Если списка полей нет, а снимка «до» тоже нет, это создание записи: показываем
 * весь снимок «после». А вот у правки пустой список полей значит «в видимых полях
 * не изменилось ничего» — так бывает, когда поменялось вырезанное поле (сумма,
 * цена, реквизиты). Показывать в таком случае весь снимок нельзя: получился бы
 * список из двух десятков полей, где «было» и «стало» совпадают.
 *
 * Служебные поля и поля, которых нет ни в одном снимке, не показываются:
 * денежные поля счёта могли быть вырезаны по праву смотрящего.
 */
export function auditChangeLines(
  event: Pick<AuditJournalEvent, "changedFields" | "beforeData" | "afterData"> & { readonly entityType?: string }
): readonly AuditChangeLine[] {
  const before = event.beforeData ?? {};
  const after = event.afterData ?? {};
  const fields = event.changedFields.length > 0
    ? event.changedFields
    : event.beforeData
      ? []
      : Object.keys(after);
  return fields
    .filter((field) => !HIDDEN_FIELDS.includes(field))
    .filter((field) => field in before || field in after)
    .map((field) => ({
      field,
      label: auditFieldLabel(field),
      before: auditValueText(before[field], field, event.entityType),
      after: auditValueText(after[field], field, event.entityType)
    }));
}

/** Сколько полей поменялось — для подписи в строке списка. */
export function auditChangeSummary(
  event: Pick<AuditJournalEvent, "changedFields" | "beforeData" | "afterData"> & { readonly entityType?: string }
): string {
  const lines = auditChangeLines(event);
  if (lines.length === 0) return "";
  const shown = lines.slice(0, 3).map((line) => line.label).join(", ");
  return lines.length > 3 ? `${shown} и ещё ${lines.length - 3}` : shown;
}

/** Причина отказа во входе по-русски. */
const LOGIN_FAILURE_LABELS: Readonly<Record<string, string>> = {
  invalid_credentials: "Неверный e-mail или пароль",
  email_not_confirmed: "E-mail не подтверждён",
  user_disabled: "Вход отключён",
  too_many_attempts: "Слишком много попыток",
  service_unavailable: "Служба входа недоступна",
  unknown: "Причина неизвестна"
};

export function loginFailureLabel(reason: string | undefined): string {
  if (!reason) return LOGIN_FAILURE_LABELS.unknown ?? "Причина неизвестна";
  return LOGIN_FAILURE_LABELS[reason] ?? reason;
}

/** Чем закончилось: вошёл или не вошёл и почему. */
export function loginOutcomeText(entry: Pick<LoginJournalEntry, "success" | "failureReason">): string {
  return entry.success ? "Вход выполнен" : loginFailureLabel(entry.failureReason);
}

/**
 * Кто входил.
 *
 * У удачного входа это запись службы входа: там сотрудник подтверждён, показываем имя.
 * У неудачной попытки подтверждать нечего: в журнале лежит набранный адрес, а набрать
 * чужой адрес может кто угодно. Поэтому у попытки первым идёт адрес, а имя сотрудника,
 * которому этот адрес принадлежит, — подписью (loginWhoHint).
 */
export function loginWhoText(entry: Pick<LoginJournalEntry, "userName" | "login" | "success">): string {
  if (entry.success) return entry.userName ?? entry.login ?? "Неизвестный вход";
  return entry.login ?? entry.userName ?? "Адрес не набран";
}

/** Подпись под «кто»: у входа — адрес, у попытки — чей это адрес, если он чей-то. */
export function loginWhoHint(entry: Pick<LoginJournalEntry, "userName" | "login" | "success">): string {
  if (entry.success) return entry.userName && entry.login ? entry.login : "";
  return entry.userName ? `адрес сотрудника: ${entry.userName}` : "";
}

/**
 * Причина отказа по ошибке входа: в журнал идёт короткий код, а не текст ошибки.
 * Пароль и то, что набрали в поле пароля, в журнал не передаётся вовсе.
 */
export function loginFailureReason(error: { readonly status?: number; readonly message?: string } | undefined): string {
  const status = error?.status;
  const message = (error?.message ?? "").toLowerCase();
  if (status === 429 || /rate limit|too many/u.test(message)) return "too_many_attempts";
  if (/not confirmed|confirm your email/u.test(message)) return "email_not_confirmed";
  if (/banned|disabled|deactivated/u.test(message)) return "user_disabled";
  if (/invalid login credentials|invalid credentials|неверный/u.test(message)) return "invalid_credentials";
  if (status === 400 || status === 401 || status === 403) return "invalid_credentials";
  if (status === undefined || status === 0 || status >= 500 || /failed to fetch|network/u.test(message)) return "service_unavailable";
  return "unknown";
}
