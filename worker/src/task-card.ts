import type { ChannelDeliveryCommand, OutboxSqlExecutor } from "./outbox.js";

/**
 * Карточка задачи в уведомлении, общая для Telegram (виджет) и почты (HTML-письмо):
 * название цветом этапа, что случилось и номер, площадка, инженер, срок, «Что доработать».
 */

/** Данные карточки из переменных плана рассылки; поля без значения пропущены. */
export interface TaskCardData {
  readonly eventCode: string;
  /** Кому уведомление: для приветствия в письме. */
  readonly recipientName?: string;
  readonly taskNumber?: string;
  readonly taskTitle?: string;
  readonly siteName?: string;
  readonly engineerName?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly reworkComment?: string;
  /** Резерв запчасти под задачу: складская цепочка «собрать — забрать». */
  readonly reservationNumber?: string;
  readonly partArticle?: string;
  readonly partName?: string;
  readonly quantity?: string;
  readonly condition?: string;
}

export interface TaskStageLook {
  /** Этап задачи после события. */
  readonly label: string;
  /** Что случилось, строкой под названием задачи. */
  readonly event: string;
  /** Цвет этапа для текста и полоски: на светлом и на тёмном фоне. */
  readonly light: string;
  readonly dark: string;
}

/** Этап задачи после события, цвета как в CRM: назначена жёлтая, в работе зелёная, на проверке синяя. */
const EVENT_LOOK: Readonly<Record<string, TaskStageLook>> = {
  task_application_accepted: { label: "Новая", event: "Заявка принята", light: "#52627a", dark: "#a3b1c6" },
  task_engineer_assigned: { label: "Назначена", event: "Назначен инженер", light: "#946300", dark: "#f2b630" },
  task_engineer_accepted: { label: "В работе", event: "Инженер принял задачу", light: "#1d7f47", dark: "#4fc47e" },
  task_work_completed: { label: "На проверке", event: "Работы завершены", light: "#1c66b8", dark: "#5ea9f2" },
  task_rework_requested: { label: "На доработке", event: "Возвращена на доработку", light: "#b9570c", dark: "#f59d4f" },
  task_overdue: { label: "Просрочена", event: "Задача просрочена", light: "#bf3434", dark: "#f27373" },
  // Резерв запчасти: цвета статусов резерва в CRM — «ждёт сборки» жёлтый, «собрана» синий.
  stock_reservation_created: { label: "Ждёт сборки", event: "Новый резерв запчастей", light: "#946300", dark: "#f2b630" },
  stock_reservation_ready: { label: "Собрана", event: "Запчасти можно забрать", light: "#1c66b8", dark: "#5ea9f2" }
};
const DEFAULT_LOOK: TaskStageLook = { label: "Задача", event: "Изменения по задаче", light: "#52627a", dark: "#a3b1c6" };

export function taskStageLook(eventCode: string): TaskStageLook {
  return (Object.hasOwn(EVENT_LOOK, eventCode) ? EVENT_LOOK[eventCode] : undefined) ?? DEFAULT_LOOK;
}

/** Комментарий «Что доработать» показываем только при возврате на доработку. */
export function isReworkEvent(eventCode: string): boolean {
  return eventCode === "task_rework_requested";
}

/** Складская цепочка: карточка рассказывает про запчасть, а задача в ней — повод. */
export function isStockEvent(eventCode: string): boolean {
  return eventCode === "stock_reservation_created" || eventCode === "stock_reservation_ready";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** Обрезает длинный текст по символам (не посреди суррогатной пары) и ставит многоточие. */
export function clipText(value: string | undefined, limit: number): string | undefined {
  const text = value?.replace(/\s+/gu, " ").trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
}

/** Многострочный текст (комментарий): переносы сохраняем, лишние пустые строки убираем. */
export function clipMultiline(value: string | undefined, limit: number): string | undefined {
  const text = value?.replace(/\r\n?/gu, "\n").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
}

/** Месяц в сроке: коротко для Telegram («нояб»), полностью для письма («ноября»). */
export type PeriodMonthStyle = "short" | "long";

function dayAndMonth(value: string | undefined, timeZone: string, month: PeriodMonthStyle): { readonly day: string; readonly month: string } | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month, timeZone }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const monthName = parts.find((part) => part.type === "month")?.value.replace(/\.$/u, "");
  return day && monthName ? { day, month: monthName } : undefined;
}

/** Срок задачи коротко: «12 нояб», «12–13 нояб», «28 нояб – 3 дек», «до 13 нояб». */
export function formatTaskPeriod(
  from: string | undefined,
  to: string | undefined,
  timeZone = "Europe/Moscow",
  month: PeriodMonthStyle = "short"
): string | undefined {
  const start = dayAndMonth(from, timeZone, month);
  const end = dayAndMonth(to, timeZone, month);
  if (!start && !end) return undefined;
  if (!start && end) return `до ${end.day} ${end.month}`;
  if (start && !end) return `с ${start.day} ${start.month}`;
  if (!start || !end) return undefined;
  if (start.day === end.day && start.month === end.month) return `${end.day} ${end.month}`;
  if (start.month === end.month) return `${start.day}–${end.day} ${end.month}`;
  return `${start.day} ${start.month} – ${end.day} ${end.month}`;
}

/** Заголовок карточки: у задачи её название, у резерва — запчасть, которую собирают. */
export function cardTitle(card: TaskCardData, limit: number): string {
  return isStockEvent(card.eventCode)
    ? clipText(card.partName, limit) ?? "Запчасть"
    : clipText(card.taskTitle, limit) ?? "Без названия";
}

/** Номер рядом с событием: у задачи её номер, у резерва — номер резерва. */
export function cardNumber(card: TaskCardData, limit: number): string | undefined {
  return clipText(isStockEvent(card.eventCode) ? card.reservationNumber : card.taskNumber, limit);
}

/** Сколько и в каком состоянии запчасть: «1 шт., новая». */
export function stockAmount(card: TaskCardData): string | undefined {
  const quantity = clipText(card.quantity, 20);
  const parts = [quantity === undefined ? undefined : `${quantity} шт.`, clipText(card.condition, 40)];
  const text = parts.filter((part): part is string => part !== undefined).join(", ");
  return text || undefined;
}

export interface CardRow {
  readonly label: string;
  readonly value: string;
  /** Значение-заглушка («не назначен»): показываем серым. */
  readonly dim: boolean;
}

/** Длина значений: в письме строка шире, в пузыре Telegram уже. */
export interface CardRowLimits {
  readonly site: number;
  readonly person: number;
  readonly part: number;
  readonly task: number;
}

/**
 * Строки карточки, общие для письма и Telegram. У задачи это площадка, инженер и срок.
 * У резерва — что собрать, сколько и для какой задачи; инженера показываем только
 * кладовщику при новом резерве: во втором уведомлении инженер читал бы про себя.
 */
export function cardRows(card: TaskCardData, limits: CardRowLimits, period: string | undefined): readonly CardRow[] {
  const site = clipText(card.siteName, limits.site);
  const engineer = clipText(card.engineerName, limits.person);
  const assigned = engineer !== undefined && engineer !== "не назначен";
  const engineerRow: CardRow = { label: "Инженер", value: assigned ? engineer : "не назначен", dim: !assigned };
  const rows: CardRow[] = [];
  if (isStockEvent(card.eventCode)) {
    const article = clipText(card.partArticle, limits.part);
    const amount = stockAmount(card);
    const title = clipText(card.taskTitle, limits.task);
    const task = [clipText(card.taskNumber, 40), title === undefined ? undefined : `«${title}»`]
      .filter((part): part is string => part !== undefined).join(" ");
    if (article) rows.push({ label: "Артикул", value: article, dim: false });
    if (amount) rows.push({ label: "Количество", value: amount, dim: false });
    if (task) rows.push({ label: "Задача", value: task, dim: false });
    if (site) rows.push({ label: "Площадка", value: site, dim: false });
    if (card.eventCode === "stock_reservation_created") rows.push(engineerRow);
    return rows;
  }
  if (site) rows.push({ label: "Площадка", value: site, dim: false });
  rows.push(engineerRow);
  if (period) rows.push({ label: "Срок", value: period, dim: false });
  return rows;
}

function optional<K extends string>(key: K, value: string | undefined): { readonly [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: string };
}

/** Данные карточки из переменных плана рассылки (jsonb). Не объект — данных нет. */
export function taskCardFromVariables(eventCode: string, variables: unknown): TaskCardData | undefined {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) return undefined;
  const text = (key: string): string | undefined => {
    const value = (variables as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  return {
    eventCode,
    ...optional("recipientName", text("recipientName")),
    ...optional("taskNumber", text("taskNumber")),
    ...optional("taskTitle", text("taskTitle")),
    ...optional("siteName", text("siteName")),
    ...optional("engineerName", text("engineerName")),
    ...optional("periodFrom", text("periodFrom")),
    ...optional("periodTo", text("periodTo")),
    ...optional("reworkComment", text("reworkComment")),
    ...optional("reservationNumber", text("reservationNumber")),
    ...optional("partArticle", text("partArticle")),
    ...optional("partName", text("partName")),
    ...optional("quantity", text("quantity")),
    ...optional("condition", text("condition"))
  };
}

/** Функции плана рассылки по каналам: они же отдают данные карточки при отправке. */
const PLAN_FUNCTIONS = {
  email: "public.load_email_event_plan",
  telegram: "public.load_telegram_event_plan"
} as const;

/**
 * Данные карточки при отправке. У сохранённой доставки есть номер события, функция плана
 * отдаёт переменные задачи для каждого получателя; строку ищем по адресу доставки.
 * Функция обрезает адрес (btrim), почту сравниваем без учёта регистра: так функция убирает повторы.
 */
export async function loadTaskCardFromPlan(
  database: OutboxSqlExecutor,
  channel: keyof typeof PLAN_FUNCTIONS,
  delivery: Pick<ChannelDeliveryCommand, "eventCode" | "recipientAddress" | "outboxEventId">
): Promise<TaskCardData | undefined> {
  if (!delivery.outboxEventId) return undefined;
  const result = await database.executeSql(
    `SELECT recipient_address, variables FROM ${PLAN_FUNCTIONS[channel]}($1::uuid)`,
    [delivery.outboxEventId]
  );
  const key = (address: string): string => (channel === "email" ? address.trim().toLowerCase() : address.trim());
  const wanted = key(delivery.recipientAddress);
  const row = result.rows.find((item) => typeof item.recipient_address === "string" && key(item.recipient_address) === wanted);
  return row ? taskCardFromVariables(delivery.eventCode, row.variables) : undefined;
}
