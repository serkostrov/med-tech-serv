import type { Permission, WorkingRole } from "./domain/access.js";
import { availableTaskActions, type AvailableTaskAction } from "./domain/task-actions.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import type { EquipmentHistoryEvent, EquipmentHistoryEventType } from "./domain/equipment-history.js";
import { assertAnnualMaintenancePlan, maintenancePeriodOnYearTimeline } from "./domain/maintenance-plan.js";
import { getSupabase, type AppSupabaseClient } from "./lib/supabase.js";
import type { PayerOption, SiteOption } from "./customer-selection.js";
import type {
  AccessRoleResponse,
  BulkTaskCommandResponse,
  EngineerTaskListItem,
  EngineerTaskListResponse,
  EquipmentFileResponse,
  EquipmentMeterReading,
  GenerateMaintenanceTasksResponse,
  MailAttachment,
  MailInboxRecord,
  MailInboxResponse,
  MaintenancePlanListResponse,
  MaintenancePlanPeriodResponse,
  NotificationJournalResponse,
  NotificationTemplateResponse,
  ReplaceAnnualMaintenancePlanRequest,
  TaskPartPosition,
  TaskPartsResponse,
  UpdateNotificationTemplateRequest
} from "./types.js";

export interface ApiSessionUser {
  readonly id: string;
  readonly fullName: string;
  readonly role: string;
  readonly accessRoleKey?: string;
  readonly accessRoleName?: string;
  readonly permissions?: readonly string[];
}

export interface AccessUserRecord extends ApiSessionUser {
  readonly email: string;
  readonly isActive: boolean;
  readonly telegramChatId?: string;
}

/** Номер чата Telegram: цифры, у групп со знаком минус. Пусто = не получать в Telegram. */
export function normalizeTelegramChatId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!/^-?\d{1,20}$/u.test(normalized)) throw new M2ApiError(400, "Номер чата Telegram должен состоять из цифр");
  return normalized;
}

/** Свой номер чата из «Моего профиля»: пробелы убираем, принимаем только номер личного чата (без минуса). */
export function ownTelegramChatId(value: unknown): string | null {
  // Номер копируют из ответа бота: пробелы внутри и по краям не мешают.
  const chat = normalizeTelegramChatId(String(value ?? "").replace(/\s+/gu, ""));
  if (chat?.startsWith("-")) {
    throw new M2ApiError(400, "Впишите номер личного чата с ботом: он без минуса. Номер группы вписывает администратор");
  }
  return chat;
}

export interface EquipmentApiRecord {
  readonly id: string;
  readonly serialNumber: string;
  readonly manufacturerId?: string;
  readonly manufacturer: string;
  readonly modelId?: string;
  readonly model: string;
  readonly guaranteeCategoryId?: string;
  readonly guaranteeCategory?: string;
  readonly organization?: string;
  readonly siteId?: string;
  readonly site?: string;
  readonly payerId?: string;
  readonly payer?: string;
  readonly status: string;
  readonly statusName?: string;
  readonly notes?: string;
  readonly lastMeterReading?: number;
}

export interface EquipmentPassportReferences {
  readonly manufacturers: readonly { readonly id: string; readonly name: string }[];
  readonly models: readonly { readonly id: string; readonly manufacturerId: string; readonly name: string }[];
  readonly guaranteeCategories: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  readonly statuses: readonly { readonly code: string; readonly name: string }[];
}

export interface ApiPage<Item> {
  readonly items: readonly Item[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface EquipmentCardResponse {
  readonly passport: EquipmentApiRecord;
  readonly history: ApiPage<EquipmentHistoryEvent>;
  readonly meterReadings: ApiPage<EquipmentMeterReading>;
  readonly files: readonly EquipmentFileResponse[];
}

export interface TaskApiRecord {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly status: string;
  readonly workTypeCode?: string;
  readonly workModifier?: "G" | "N";
  readonly hours?: number;
  readonly priority?: "urgent" | "planned";
  readonly isMaintenancePlan?: boolean;
  readonly maintenancePlanId?: string;
  readonly siteId?: string;
  readonly siteContactId?: string;
  readonly initiatorContactId?: string;
  readonly initiatorName?: string;
  readonly payerId?: string;
  readonly equipmentId?: string;
  /** Краткое описание прибора, приходит вместе с задачей (для доски и списка). */
  readonly equipmentLabel?: { readonly serialNumber: string; readonly model?: string; readonly manufacturer?: string };
  readonly engineerId?: string;
  /** Имя инженера, приходит вместе с задачей. */
  readonly engineerName?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly callDate?: string;
  readonly visitDate?: string;
  readonly completedAt?: string;
  readonly workStartedAt?: string;
  readonly workFinishedAt?: string;
  readonly contractId?: string;
  readonly contractNumber?: string;
  readonly primaryTaskId?: string;
  readonly primaryTaskNumber?: string;
  readonly continuationTaskId?: string;
  readonly continuationTaskNumber?: string;
  readonly reasonCode?: string;
  readonly callReason?: string;
  readonly workDescription?: string;
  readonly recommendations?: string;
  readonly userRemarks?: string;
  readonly meterReading?: number;
  readonly workCompleted?: boolean;
  readonly apparatusApproved?: boolean;
  readonly customerHasNoClaims?: boolean;
  readonly continuedInPrimary?: boolean;
  readonly cancellationReason?: string;
  readonly reworkComment?: string;
  readonly isOverdue?: boolean;
  /** Место карточки в колонке доски, если его задали вручную (только для запросов доски). */
  readonly boardPosition?: number;
  readonly customer?: {
    readonly siteName: string;
    readonly address: string;
    readonly contactFullName?: string;
    readonly contactPhone?: string;
    readonly contactEmail?: string;
    readonly payerName?: string;
  };
  readonly initiator?: {
    readonly contactId?: string;
    readonly fullName?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskCardResponse {
  readonly task: TaskApiRecord;
  readonly equipment?: EquipmentApiRecord;
  readonly engineer?: { readonly id: string; readonly fullName: string };
  readonly workType?: { readonly code: string; readonly name: string };
  readonly reason?: { readonly code: string; readonly name: string };
  readonly status: { readonly code: string; readonly name: string };
  readonly closure?: {
    readonly taskId: string;
    readonly actFileId: string;
    readonly submittedBy?: string;
    readonly submittedByName?: string;
    readonly submittedAt: string;
    readonly verifiedBy?: string;
    readonly verifiedAt?: string;
    readonly verificationComment?: string;
    readonly workCompleted?: boolean;
    readonly apparatusApproved?: boolean;
    readonly customerHasNoClaims?: boolean;
    readonly callReason?: string;
    readonly workDescription?: string;
    readonly recommendations?: string;
    readonly userRemarks?: string;
    readonly continuedInPrimary?: boolean;
    readonly continuationTaskId?: string;
    readonly continuationTaskNumber?: string;
    readonly meterReading?: number;
    readonly workModifier?: "G" | "N";
    readonly hours?: number;
  };
  readonly parts: readonly TaskPartPosition[];
  readonly canEditOverview?: boolean;
  readonly canEditParts: boolean;
  readonly canUploadFiles?: boolean;
  /** Сменить инженера (право назначения, задача назначена или в работе). */
  readonly canReassign?: boolean;
  /** Заполнить результат и сдать задачу: инженер этой задачи с правом закрытия. */
  readonly canSubmitResult?: boolean;
  /** Ставить Г/Н: от этого зависит счёт, поэтому только координатор (tasks.write). */
  readonly canSetWorkModifier?: boolean;
  /** Видеть плательщика и договор (finance.read), на любом этапе задачи. */
  readonly canSeeFinance?: boolean;
  /** Открывший карточку — инженер этой задачи. */
  readonly isTaskEngineer?: boolean;
  readonly files: readonly EquipmentFileResponse[];
  readonly journal: readonly {
    readonly id: string;
    readonly action: string;
    readonly description?: string;
    readonly occurredAt: string;
    readonly actorName?: string;
    readonly fromStatus?: string;
    readonly toStatus?: string;
    readonly comment?: string;
  }[];
  readonly availableActions: readonly AvailableTaskAction[];
}

export interface AssignmentSuggestionRecord {
  readonly engineerId: string;
  readonly fullName: string;
  readonly isAvailable: boolean;
  readonly previouslyWorkedWithEquipment: boolean;
}

export interface InvoiceApiRecord {
  readonly id: string;
  readonly number: string;
  readonly status: "cancelled" | "draft" | "issued" | "transferred_to_1c";
  readonly taskIds: readonly string[];
  readonly payer: { readonly id: string; readonly name: string; readonly requisites: Readonly<Record<string, string>> };
  readonly payerSelection: { readonly source: "equipment" | "manual" | "override"; readonly overrideReason?: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReferenceCatalogDescriptor {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly codeRequired: boolean;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly type: "boolean" | "integer" | "number" | "reference" | "text";
    readonly required?: boolean;
    readonly readOnly?: boolean;
    readonly referenceCatalog?: string;
  }[];
}

export interface ReferenceCatalogValue {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EngineerOverview {
  readonly id: string;
  readonly fullName: string;
  readonly isActive: boolean;
  readonly competencies: readonly { readonly manufacturer?: string; readonly modelLine?: string }[];
  readonly assignedTaskCount: number;
  readonly inProgressTaskCount: number;
  readonly overdueTaskCount: number;
}

export interface InventoryPartRecord {
  readonly id: string;
  readonly articleNumber: string;
  readonly name: string;
  readonly minimumStock: number;
  readonly notes?: string;
  readonly isActive: boolean;
  readonly onHandQuantity: number;
  readonly reservedQuantity: number;
  readonly availableQuantity: number;
  readonly withEngineersQuantity: number;
  readonly belowMinimum: boolean;
}

export interface InventoryPartPage extends ApiPage<InventoryPartRecord> {
  readonly summary: { readonly active: number; readonly belowMinimum: number; readonly withEngineers: number };
  readonly hasMore: boolean;
  readonly nextOffset?: number;
}

/** Резерв запчасти под задачу: создан, собран на складе, выдан инженеру, установлен, возвращён или отменён. */
export type StockReservationStatus = "created" | "warehouse_notified" | "issued" | "installed" | "returned" | "cancelled";

export const ACTIVE_RESERVATION_STATUSES: readonly StockReservationStatus[] = ["created", "warehouse_notified", "issued"];
export const CLOSED_RESERVATION_STATUSES: readonly StockReservationStatus[] = ["installed", "returned", "cancelled"];

export interface StockReservationRecord {
  readonly id: string;
  readonly number: string;
  readonly status: StockReservationStatus;
  readonly partId: string;
  readonly articleNumber: string;
  readonly partName: string;
  readonly condition: "G" | "N" | "B";
  readonly quantity: number;
  readonly taskId?: string;
  readonly taskNumber?: string;
  readonly taskTitle?: string;
  /** Этап задачи (status_code): по отменённой или закрытой задаче выдавать не нужно. */
  readonly taskStatus?: string;
  /** Инженер задачи: ему выдаётся запчасть. */
  readonly engineerName?: string;
  /** Кому выдали на самом деле (после выдачи). */
  readonly issuedToName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationsReportRecord {
  readonly period: { readonly from: string; readonly to: string };
  readonly metrics: {
    readonly taskCount: number;
    readonly closedCount: number;
    readonly closedOnTimePercent: number;
    readonly overdueCount: number;
    readonly activeEngineerCount: number;
    readonly belowMinimumCount: number;
  };
  readonly tasksByStatus: readonly { readonly code: string; readonly name: string; readonly value: number }[];
  readonly tasksByWorkType: readonly { readonly code: string; readonly name: string; readonly value: number }[];
  readonly tasksByMonth: readonly { readonly key: string; readonly name: string; readonly value: number }[];
}

/** Заявка для выгрузки отчёта в Excel: одна строка листа «Заявки». */
export interface ReportTaskRow {
  readonly number: string;
  readonly createdAt: string;
  readonly title: string;
  readonly status: string;
  readonly statusName: string;
  readonly priority: "urgent" | "planned";
  readonly workTypeName?: string;
  readonly siteName?: string;
  readonly equipment?: string;
  readonly serialNumber?: string;
  readonly engineerName?: string;
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly completedAt?: string;
}

export class M2ApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "M2ApiError";
  }
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function optionalText(row: Row, key: string): string | undefined {
  const value = text(row, key).trim();
  return value || undefined;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return "";
}

const REPORT_MONTH_NAMES = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"] as const;

function reportMonthsInRange(from: string, to: string): readonly string[] {
  const start = from.slice(0, 7);
  const end = to.slice(0, 7);
  if (!/^\d{4}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}$/u.test(end) || start > end) return [];
  const keys: string[] = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

function reportMonthLabel(key: string): string {
  const month = Number(key.slice(5, 7));
  const name = REPORT_MONTH_NAMES[month - 1];
  return name ? `${name} ${key.slice(0, 4)}` : key;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const MAIL_SELECT = "id, sender, subject, body, received_at, status, ai_confidence, parsed_payload, parsed_at, task_id, raw_storage_key, attachments, autoreply_sent_at, autoreply_error";

function mailRecord(row: Record<string, unknown>): MailInboxRecord {
  const payload = asRow(row.parsed_payload);
  const flag = (key: string): boolean | undefined => (typeof payload[key] === "boolean" ? payload[key] as boolean : undefined);
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.map((item) => asRow(item)).filter((item) => typeof item.storageKey === "string").map((item): MailAttachment => ({
        storageKey: String(item.storageKey),
        fileName: typeof item.fileName === "string" && item.fileName ? item.fileName : "вложение",
        contentType: typeof item.contentType === "string" ? item.contentType : "application/octet-stream",
        byteSize: typeof item.byteSize === "number" ? item.byteSize : 0
      }))
    : [];
  const record: Record<string, unknown> = {
    id: text(row, "id"),
    sender: text(row, "sender"),
    subject: text(row, "subject"),
    receivedAt: iso(row.received_at),
    status: text(row, "status") as MailInboxRecord["status"],
    confidence: numberValue(row.ai_confidence),
    summary: optionalText(payload, "summary"),
    equipmentSerial: optionalText(payload, "equipmentSerial"),
    workTypeCode: optionalText(payload, "workTypeCode"),
    taskId: optionalText(row, "task_id"),
    client: optionalText(payload, "client"),
    contactName: optionalText(payload, "contactName"),
    contactPhone: optionalText(payload, "contactPhone"),
    equipmentName: optionalText(payload, "equipmentName"),
    equipmentFound: flag("equipmentFound"),
    equipmentId: optionalText(payload, "equipmentId"),
    equipmentLabel: optionalText(payload, "equipmentLabel"),
    description: optionalText(payload, "description"),
    lowConfidence: flag("lowConfidence"),
    body: optionalText(row, "body"),
    rawStorageKey: optionalText(row, "raw_storage_key"),
    wasParsed: Boolean(row.parsed_at),
    autoreplyError: optionalText(row, "autoreply_error"),
    autoreplySent: Boolean(row.autoreply_sent_at) && !optionalText(row, "autoreply_error"),
    attachments
  };
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  return record as unknown as MailInboxRecord;
}

/**
 * Безопасная часть ключа в хранилище. Storage принимает в ключе только латиницу,
 * цифры и простые знаки: имя «Снимок экрана — 2026-11-11 в 15.00.30.png»
 * отклонялось с «Invalid key». В ключе оставляем только расширение,
 * а исходное имя файла хранится в files.original_name.
 */
export function storageObjectName(fileName: string): string {
  const extension = /\.([A-Za-z0-9]{1,10})$/u.exec(fileName)?.[1]?.toLowerCase();
  return `${crypto.randomUUID()}${extension ? `.${extension}` : ""}`;
}

function related(row: Row, key: string): Row {
  const value = row[key];
  if (Array.isArray(value)) return asRow(value[0]);
  return asRow(value);
}

function mapPayerOption(row: Row): PayerOption {
  const requisites = asRow(row.requisites);
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    isActive: row.is_active !== false,
    ...(optionalText(requisites, "inn") ? { inn: text(requisites, "inn") } : {}),
    ...(optionalText(requisites, "kpp") ? { kpp: text(requisites, "kpp") } : {})
  };
}

function mapOptionalPayer(value: unknown): PayerOption | undefined {
  if (value == null) return undefined;
  const row = Array.isArray(value) ? asRow(value[0]) : asRow(value);
  if (!row.id) return undefined;
  return mapPayerOption(row);
}

function mapContactOption(row: Row): SiteOption["contacts"][number] {
  return {
    id: text(row, "id"),
    fullName: text(row, "full_name"),
    phone: optionalText(row, "phone"),
    email: optionalText(row, "email"),
    isPrimary: row.is_primary === true,
    isActive: row.is_active !== false,
    ...(optionalText(row, "payer_id") ? { payerId: text(row, "payer_id") } : {})
  };
}

export function publicApiErrorMessage(message: string | undefined, fallback = "Не получилось выполнить запрос"): string {
  const text = message?.trim() ?? "";
  if (!text) return fallback;
  if (/tasks_core_relations_required/iu.test(text)) {
    return "У прибора должны быть указаны площадка и плательщик.";
  }
  if (/tasks_execution_period_required/iu.test(text)) {
    return "Укажите период выполнения: даты «с» и «по».";
  }
  if (/tasks_payer_override_audit_required|Для замены плательщика задачи обязательны/iu.test(text)) {
    return "У прибора уже есть плательщик. Чтобы выбрать другого, укажите причину смены.";
  }
  if (/tasks_payer_override_forbidden|Недостаточно прав для замены плательщика/iu.test(text)) {
    return "Недостаточно прав, чтобы выбрать другого плательщика.";
  }
  if (/tasks_engineer_required_after_assignment/iu.test(text)) {
    return "Для этого статуса нужно назначить инженера.";
  }
  // Коды статусов из базы («under_review») показываем по-русски.
  const transition = /Недопустимый переход задачи: (\w+) -> (\w+)/u.exec(text) ?? /перевести задачу из «(\w+)» в «(\w+)»/u.exec(text);
  if (transition) {
    const from = TASK_STATUS_LABELS[transition[1] ?? ""] ?? transition[1];
    const to = TASK_STATUS_LABELS[transition[2] ?? ""] ?? transition[2];
    return /Недостаточно прав/u.test(text)
      ? `Перевести задачу из «${from}» в «${to}» может только координатор.`
      : `Задачу нельзя перевести из «${from}» сразу в «${to}». Двигайте её по этапам по порядку.`;
  }
  if (/Недопустимый переход резерва/u.test(text)) {
    return "Резерв уже в другом состоянии. Обновите список резервов.";
  }
  if (/invalid input syntax for type uuid|22P02/iu.test(text)) {
    return "Некорректное значение фильтра. Сбросьте фильтры и выберите значение из списка.";
  }
  if (/[а-яё]/iu.test(text)) return text;
  if (/more than one relationship was found|Could not embed/iu.test(text)) {
    return "Не получилось загрузить связанные данные. Обновите страницу.";
  }
  if (/JWT expired|invalid JWT|not authenticated|Auth session missing/iu.test(text)) {
    return "Сессия истекла. Войдите снова.";
  }
  if (/permission denied|row-level security|PGRST301|42501/iu.test(text)) {
    return "Недостаточно прав для этого действия.";
  }
  if (/duplicate key|already exists|23505/iu.test(text)) {
    return "Такая запись уже есть.";
  }
  if (/violates check constraint|23514/iu.test(text)) {
    return "Проверьте обязательные поля: часть данных не заполнена или указана неверно.";
  }
  if (/violates foreign key|23503/iu.test(text)) {
    return "Нельзя сохранить: связанная запись не найдена или ещё используется.";
  }
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/iu.test(text)) {
    return "Нет связи с сервером. Проверьте сеть и попробуйте снова.";
  }
  if (/Could not find the function|PGRST202/iu.test(text)) {
    return "На сервере нет этой операции. Нужно обновить схему базы.";
  }
  if (/signup_disabled|Signups not allowed for this instance/iu.test(text)) {
    return "Публичная регистрация отключена. Сотрудника добавляет администратор.";
  }
  if (/email_exists|User already registered|already been registered/iu.test(text)) {
    return "Пользователь с таким e-mail уже есть.";
  }
  if (/weak_password|Password should|password is known to be/iu.test(text)) {
    return "Пароль не подходит. Задайте другой, не короче 8 символов.";
  }
  return fallback;
}

const RESERVATION_STATUSES: readonly StockReservationStatus[] = [...ACTIVE_RESERVATION_STATUSES, ...CLOSED_RESERVATION_STATUSES];

/**
 * Строка stock_reservations со встроенными запчастью, задачей и инженерами. Задачу кладовщик
 * видит, пока резерв действует: у закрытых резервов задача приходит пустой.
 */
export function stockReservationRecord(row: Row): StockReservationRecord {
  const part = asRow(row.part);
  const task = asRow(row.task);
  const statusText = text(row, "status");
  const status = (RESERVATION_STATUSES as readonly string[]).includes(statusText) ? statusText as StockReservationStatus : "created";
  const conditionText = text(row, "part_condition");
  const condition = conditionText === "G" || conditionText === "B" ? conditionText : "N";
  const taskId = optionalText(row, "task_id");
  const taskNumber = optionalText(task, "number");
  const taskTitle = optionalText(task, "title");
  const taskStatus = optionalText(task, "status_code");
  const engineerName = optionalText(asRow(task.engineer), "full_name");
  const issuedToName = optionalText(asRow(row.issued), "full_name");
  return {
    id: text(row, "id"),
    number: text(row, "number"),
    status,
    partId: text(row, "part_id"),
    articleNumber: text(part, "article_number"),
    partName: text(part, "name"),
    condition,
    quantity: numberValue(row.quantity) ?? 0,
    ...(taskId ? { taskId } : {}),
    ...(taskNumber ? { taskNumber } : {}),
    ...(taskTitle ? { taskTitle } : {}),
    ...(taskStatus ? { taskStatus } : {}),
    ...(engineerName ? { engineerName } : {}),
    ...(issuedToName ? { issuedToName } : {}),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at")
  };
}

function throwIfError(error: { readonly message?: string } | null, fallback = "Не получилось выполнить запрос"): void {
  if (error) throw new M2ApiError(400, publicApiErrorMessage(error.message, fallback));
}

/** Любой uuid-подобный id (в т.ч. v7), без жёсткой проверки version/variant. */
function isFilterUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function normalizeFilterValue(value: string | undefined): string | undefined {
  const raw = value?.trim().replace(/^(?:\.\$?)+/u, "");
  return raw || undefined;
}

function escapeIlikePattern(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/[%_]/gu, "\\$&");
}

/** Убирает метасимволы PostgREST из поисковой строки внутри `.or(...)`. */
function escapePostgrestSearchTerm(value: string): string {
  return value.trim().replace(/[%_,.()\\]/gu, "");
}

function paged<Item>(items: readonly Item[], total: number, limit: number, offset: number): ApiPage<Item> {
  return { items, total, limit, offset };
}

const FILE_SELECT = "id, kind, original_name, content_type, byte_size, created_at, storage_key, equipment_id, is_financial";

const EQUIPMENT_SELECT = `
  id, serial_number, status_code, notes, last_meter_reading, current_site_id, current_payer_id,
  manufacturer_id, model_id, guarantee_category_id,
  manufacturer:manufacturers(id, name),
  model:equipment_models(id, name, manufacturer_id),
  guarantee_category:guarantee_categories(id, code, name),
  status:equipment_statuses(code, name),
  site:sites!current_site_id(id, name, organization_id, organization:organizations(name)),
  payer:payers!current_payer_id(id, name)
`;

const TASK_SELECT = `
  id, number, title, status_code, work_type_code, work_modifier, hours, priority,
  is_maintenance_plan, maintenance_plan_id, site_id, site_contact_id, initiator_contact_id,
  initiator_name, payer_id, equipment_id,
  engineer_id, deadline_from, deadline_to, call_date, visit_date, completed_at,
  work_started_at, work_finished_at, contract_id, primary_task_id, reason_code,
  call_reason, work_description, recommendations, user_remarks, meter_reading,
  work_completed, apparatus_approved, customer_has_no_claims, continued_in_primary,
  cancellation_reason, rework_comment, created_at, updated_at,
  site:sites!site_id(name, address),
  payer:payers!payer_id(name),
  contact:site_contacts!site_contact_id(full_name, phone, email),
  initiator_contact:site_contacts!initiator_contact_id(full_name),
  contract:contracts(number),
  status:task_statuses(code, name),
  device:equipment!equipment_id(serial_number, model:equipment_models(name), maker:manufacturers(name)),
  engineer:users!engineer_id(full_name)
`;

const TASK_SELECT_WITHOUT_INITIATOR_CONTACT = `
  id, number, title, status_code, work_type_code, work_modifier, hours, priority,
  is_maintenance_plan, maintenance_plan_id, site_id, site_contact_id, payer_id, equipment_id,
  engineer_id, deadline_from, deadline_to, call_date, visit_date, completed_at,
  work_started_at, work_finished_at, contract_id, primary_task_id, reason_code,
  call_reason, work_description, recommendations, user_remarks, meter_reading,
  work_completed, apparatus_approved, customer_has_no_claims, continued_in_primary,
  cancellation_reason, rework_comment, created_at, updated_at,
  site:sites!site_id(name, address),
  payer:payers!payer_id(name),
  contact:site_contacts!site_contact_id(full_name, phone, email),
  contract:contracts(number),
  status:task_statuses(code, name),
  device:equipment!equipment_id(serial_number, model:equipment_models(name), maker:manufacturers(name)),
  engineer:users!engineer_id(full_name)
`;

/** После 0007 в tasks появляются initiator_contact_id / initiator_name. Пока миграции нет — select без них. */
let tasksInitiatorContactAvailable: boolean | null = null;

type PageResponse = { readonly data: unknown; readonly error: { readonly message?: string } | null; readonly count?: number | null };

/**
 * Все строки запроса. Сервер отдаёт не больше 1000 строк за раз, поэтому читаем страницами:
 * первая страница заодно сообщает, сколько всего строк, остальные идут до 4 одновременно.
 * Запрос должен быть упорядочен однозначно (например, по дате и id), иначе страницы перекроются.
 */
export async function allPages(
  request: (from: number, to: number, withCount: boolean) => PromiseLike<PageResponse>,
  failure: string,
  pageSize = 1000
): Promise<unknown[]> {
  const rowsOf = (response: PageResponse): unknown[] => {
    throwIfError(response.error, failure);
    return Array.isArray(response.data) ? response.data : [];
  };
  const first = await request(0, pageSize - 1, true);
  const rows = rowsOf(first);
  const total = typeof first.count === "number" ? first.count : undefined;
  if (rows.length === 0 || (total !== undefined && rows.length >= total)) return rows;
  // Если сервер отдаёт меньше строк за раз, чем мы просили, читаем его страницами.
  const size = total !== undefined ? rows.length : pageSize;
  if (total === undefined && rows.length < pageSize) return rows;
  const offsets: number[] = [];
  if (total !== undefined) for (let offset = size; offset < total; offset += size) offsets.push(offset);
  const pages: unknown[][] = new Array<unknown[]>(offsets.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(4, offsets.length) }, async () => {
    while (next < offsets.length && !failed) {
      const index = next;
      next += 1;
      const offset = offsets[index] ?? 0;
      try {
        pages[index] = rowsOf(await request(offset, offset + size - 1, false));
      } catch (error) {
        // Одна страница не загрузилась: остальные не запрашиваем, ошибка уйдёт наверх.
        failed = true;
        throw error;
      }
    }
  }));
  for (const page of pages) rows.push(...(page ?? []));
  // Пока читали, могли добавиться строки (или общего числа нет): дочитываем, пока страница полная.
  let last = pages.length > 0 ? pages[pages.length - 1] ?? [] : rows;
  let offset = size * (offsets.length + 1);
  while (last.length >= size) {
    last = rowsOf(await request(offset, offset + size - 1, false));
    rows.push(...last);
    offset += size;
  }
  return rows;
}

/** День по местному времени («2026-11-12») для момента ISO; строка без времени возвращается как есть. */
export function localDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return value.slice(0, 10);
  return `${moment.getFullYear()}-${String(moment.getMonth() + 1).padStart(2, "0")}-${String(moment.getDate()).padStart(2, "0")}`;
}

/** Закрыта вовремя: день закрытия (по местному времени) не позже конца срока. Без срока или даты: не считаем. */
export function closedOnTime(completedAt: string | undefined, deadlineTo: string | undefined): boolean | undefined {
  const completed = localDay(completedAt);
  const deadline = deadlineTo?.slice(0, 10);
  if (!completed || !deadline) return undefined;
  return completed <= deadline;
}

/** Границы периода отчёта по местному времени: с начала первого дня до конца последнего. */
export function reportPeriodBounds(from: string, to: string): { readonly start: string; readonly end: string } {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T23:59:59.999`);
  return {
    start: Number.isNaN(start.getTime()) ? from : start.toISOString(),
    end: Number.isNaN(end.getTime()) ? `${to}T23:59:59.999Z` : end.toISOString()
  };
}

/**
 * Просрочена ли заявка в отчёте за период: открыта и срок вышел к концу периода,
 * но не позже сегодняшнего дня (период может заканчиваться в будущем).
 */
export function reportTaskOverdue(deadlineTo: string | undefined, status: string, periodTo: string, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!deadlineTo || status === "closed" || status === "cancelled") return false;
  const reference = periodTo < today ? periodTo : today;
  return deadlineTo.slice(0, 10) < reference;
}

/** Порядок карточек на доске появляется с миграцией 0019. Пока её нет, доска сортирует как раньше. */
let boardOrderAvailable = true;

/** Ошибка из-за того, что в базе ещё нет порядка карточек (миграция 0019 не применена). */
function isMissingBoardOrderSchema(error: { readonly message?: string; readonly code?: string; readonly details?: string; readonly hint?: string } | null): boolean {
  if (!error) return false;
  const blob = [error.message, error.code, error.details, error.hint].filter(Boolean).join(" ");
  return /board_position/iu.test(blob);
}

export function mapEquipment(row: Row): EquipmentApiRecord {
  const manufacturer = related(row, "manufacturer");
  const model = related(row, "model");
  const site = related(row, "site");
  const payer = related(row, "payer");
  const status = related(row, "status");
  const guarantee = related(row, "guarantee_category");
  const lastMeterReading = numberValue(row.last_meter_reading);
  return {
    id: text(row, "id"),
    serialNumber: text(row, "serial_number"),
    manufacturerId: optionalText(row, "manufacturer_id") ?? optionalText(manufacturer, "id"),
    manufacturer: text(manufacturer, "name"),
    modelId: optionalText(row, "model_id") ?? optionalText(model, "id"),
    model: text(model, "name"),
    guaranteeCategoryId: optionalText(row, "guarantee_category_id") ?? optionalText(guarantee, "id"),
    guaranteeCategory: optionalText(guarantee, "name"),
    organization: optionalText(related(site, "organization"), "name"),
    siteId: optionalText(row, "current_site_id") ?? optionalText(site, "id"),
    site: optionalText(site, "name"),
    payerId: optionalText(row, "current_payer_id") ?? optionalText(payer, "id"),
    payer: optionalText(payer, "name"),
    status: text(row, "status_code") || text(status, "code"),
    statusName: optionalText(status, "name"),
    notes: optionalText(row, "notes"),
    ...(lastMeterReading !== undefined ? { lastMeterReading } : {})
  };
}

export function mapTask(row: Row): TaskApiRecord {
  const site = related(row, "site");
  const payer = related(row, "payer");
  const contact = related(row, "contact");
  const initiatorContact = related(row, "initiator_contact");
  const contract = related(row, "contract");
  const periodTo = optionalText(row, "deadline_to");
  const status = text(row, "status_code");
  const isOverdue = Boolean(periodTo && !["closed", "cancelled"].includes(status) && periodTo < new Date().toISOString().slice(0, 10));
  const hours = numberValue(row.hours);
  const meterReading = numberValue(row.meter_reading);
  const workModifier = text(row, "work_modifier");
  const initiatorContactId = optionalText(row, "initiator_contact_id");
  const initiatorName = optionalText(row, "initiator_name") ?? optionalText(initiatorContact, "full_name");
  const device = related(row, "device");
  const deviceSerial = optionalText(device, "serial_number");
  const engineerRow = related(row, "engineer");
  const boardPosition = numberValue(row.board_position);
  return {
    id: text(row, "id"),
    number: text(row, "number"),
    title: text(row, "title"),
    status,
    workTypeCode: optionalText(row, "work_type_code"),
    ...(workModifier === "G" || workModifier === "N" ? { workModifier } : {}),
    ...(hours !== undefined ? { hours } : {}),
    priority: text(row, "priority") === "urgent" ? "urgent" : "planned",
    isMaintenancePlan: row.is_maintenance_plan === true,
    maintenancePlanId: optionalText(row, "maintenance_plan_id"),
    siteId: optionalText(row, "site_id"),
    siteContactId: optionalText(row, "site_contact_id"),
    initiatorContactId,
    ...(initiatorName ? { initiatorName } : {}),
    payerId: optionalText(row, "payer_id"),
    equipmentId: optionalText(row, "equipment_id"),
    ...(deviceSerial ? { equipmentLabel: {
      serialNumber: deviceSerial,
      ...(optionalText(related(device, "model"), "name") ? { model: optionalText(related(device, "model"), "name") } : {}),
      ...(optionalText(related(device, "maker"), "name") ? { manufacturer: optionalText(related(device, "maker"), "name") } : {})
    } } : {}),
    engineerId: optionalText(row, "engineer_id"),
    ...(optionalText(engineerRow, "full_name") ? { engineerName: optionalText(engineerRow, "full_name") } : {}),
    periodFrom: optionalText(row, "deadline_from"),
    periodTo,
    callDate: optionalText(row, "call_date"),
    visitDate: optionalText(row, "visit_date"),
    completedAt: optionalText(row, "completed_at"),
    workStartedAt: optionalText(row, "work_started_at"),
    workFinishedAt: optionalText(row, "work_finished_at"),
    contractId: optionalText(row, "contract_id"),
    contractNumber: optionalText(contract, "number"),
    primaryTaskId: optionalText(row, "primary_task_id"),
    reasonCode: optionalText(row, "reason_code"),
    callReason: optionalText(row, "call_reason"),
    workDescription: optionalText(row, "work_description"),
    recommendations: optionalText(row, "recommendations"),
    userRemarks: optionalText(row, "user_remarks"),
    ...(meterReading !== undefined ? { meterReading } : {}),
    workCompleted: row.work_completed === true,
    apparatusApproved: row.apparatus_approved === true,
    customerHasNoClaims: row.customer_has_no_claims === true,
    continuedInPrimary: row.continued_in_primary === true,
    cancellationReason: optionalText(row, "cancellation_reason"),
    reworkComment: optionalText(row, "rework_comment"),
    isOverdue,
    ...(boardPosition !== undefined ? { boardPosition } : {}),
    customer: {
      siteName: text(site, "name"),
      address: text(site, "address"),
      contactFullName: optionalText(contact, "full_name"),
      contactPhone: optionalText(contact, "phone"),
      contactEmail: optionalText(contact, "email"),
      payerName: optionalText(payer, "name")
    },
    ...(initiatorContactId || initiatorName
      ? { initiator: { ...(initiatorContactId ? { contactId: initiatorContactId } : {}), ...(initiatorName ? { fullName: initiatorName } : {}) } }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const CATALOGS: readonly ReferenceCatalogDescriptor[] = [
  { key: "work-types", label: "Виды работ", description: "Виды сервисных работ и требование учёта часов", codeRequired: true, fields: [{ key: "requiresHours", label: "Требуются часы", type: "boolean", readOnly: true }, { key: "sortOrder", label: "Порядок", type: "integer" }] },
  { key: "manufacturers", label: "Производители", description: "Производители медицинского оборудования", codeRequired: false, fields: [{ key: "sortOrder", label: "Порядок", type: "integer" }] },
  { key: "equipment-models", label: "Модели приборов", description: "Модели с обязательной привязкой к производителю", codeRequired: false, fields: [{ key: "manufacturerId", label: "Производитель", type: "reference", required: true, referenceCatalog: "manufacturers" }, { key: "category", label: "Категория", type: "text" }, { key: "sortOrder", label: "Порядок", type: "integer" }] },
  { key: "guarantee-categories", label: "Категории гарантии", description: "Условия и покрытие гарантии поставщика", codeRequired: true, fields: [{ key: "supplierWarrantyMonths", label: "Срок, месяцев", type: "integer" }, { key: "supplierCoveragePercent", label: "Покрытие, %", type: "number" }, { key: "sortOrder", label: "Порядок", type: "integer" }] },
  { key: "equipment-statuses", label: "Статусы приборов", description: "Какие состояния бывают у приборов", codeRequired: true, fields: [{ key: "sortOrder", label: "Порядок", type: "integer" }] },
  { key: "task-statuses", label: "Статусы задач", description: "Этапы заявки и их порядок", codeRequired: true, fields: [{ key: "sortOrder", label: "Порядок", type: "integer" }, { key: "isTerminal", label: "Последний этап", type: "boolean" }] },
  { key: "task-reasons", label: "Причины обращений", description: "Причины сервисного случая при закрытии задачи", codeRequired: true, fields: [{ key: "sortOrder", label: "Порядок", type: "integer" }] }
];

function applyCatalogAttributes(patch: Row, attributes: Row): void {
  if (attributes.sortOrder !== undefined) patch.sort_order = attributes.sortOrder;
  if (attributes.manufacturerId !== undefined) patch.manufacturer_id = attributes.manufacturerId;
  if (attributes.category !== undefined) patch.category = attributes.category;
  if (attributes.isTerminal !== undefined) patch.is_terminal = attributes.isTerminal;
  if (attributes.supplierWarrantyMonths !== undefined) patch.supplier_warranty_months = attributes.supplierWarrantyMonths;
  if (attributes.supplierCoveragePercent !== undefined) patch.supplier_coverage_percent = attributes.supplierCoveragePercent;
}

const CATALOG_TABLE: Readonly<Record<string, { readonly table: string; readonly id: string; readonly code?: string }>> = {
  "work-types": { table: "work_types", id: "code", code: "code" },
  manufacturers: { table: "manufacturers", id: "id" },
  "equipment-models": { table: "equipment_models", id: "id" },
  "guarantee-categories": { table: "guarantee_categories", id: "id", code: "code" },
  "equipment-statuses": { table: "equipment_statuses", id: "code", code: "code" },
  "task-statuses": { table: "task_statuses", id: "code", code: "code" },
  "task-reasons": { table: "task_reasons", id: "code", code: "code" }
};

export class M2ApiClient {
  public constructor(private readonly client?: AppSupabaseClient) {}

  private db(): AppSupabaseClient {
    return this.client ?? getSupabase();
  }

  private async actorId(): Promise<string> {
    // Id берётся из локальной сессии без запроса к серверу: раньше каждое действие
    // ждало лишний ответ сервера. Права всё равно проверяет база по токену (auth.uid()).
    const { data: sessionData } = await this.db().auth.getSession();
    const sessionUserId = sessionData.session?.user.id;
    if (sessionUserId) return sessionUserId;
    const { data, error } = await this.db().auth.getUser();
    throwIfError(error, "Не удалось прочитать сессию");
    if (!data.user) throw new M2ApiError(401, "Нужна сессия");
    return data.user.id;
  }

  private isMissingInitiatorContactSchema(error: {
    readonly message?: string;
    readonly code?: string;
    readonly details?: string;
    readonly hint?: string;
  } | null): boolean {
    if (!error) return false;
    const blob = [error.message, error.code, error.details, error.hint].filter(Boolean).join(" ");
    return /initiator_contact|initiator_name|PGRST204|PGRST200|42703|schema cache|does not exist|Could not find.*column|Could not find.*relationship/iu.test(blob);
  }

  private taskSelect(): string {
    return tasksInitiatorContactAvailable === false ? TASK_SELECT_WITHOUT_INITIATOR_CONTACT : TASK_SELECT;
  }

  private markInitiatorContactUnavailable(): void {
    tasksInitiatorContactAvailable = false;
  }

  private markInitiatorContactAvailable(): void {
    if (tasksInitiatorContactAvailable == null) tasksInitiatorContactAvailable = true;
  }

  private async loadTask(id: string): Promise<TaskApiRecord> {
    const select = this.taskSelect();
    const primary = await this.db().from("tasks").select(select).eq("id", id).maybeSingle();
    if (primary.error && select === TASK_SELECT && this.isMissingInitiatorContactSchema(primary.error)) {
      this.markInitiatorContactUnavailable();
      const fallback = await this.db().from("tasks").select(TASK_SELECT_WITHOUT_INITIATOR_CONTACT).eq("id", id).maybeSingle();
      throwIfError(fallback.error);
      if (!fallback.data) throw new M2ApiError(404, "Задача не найдена");
      return mapTask(asRow(fallback.data));
    }
    throwIfError(primary.error);
    if (!primary.data) throw new M2ApiError(404, "Задача не найдена");
    if (select === TASK_SELECT) this.markInitiatorContactAvailable();
    return mapTask(asRow(primary.data));
  }

  /** Задача для карточки: сразу с видом работ, причиной и прибором целиком. */
  private async loadTaskCardRow(id: string): Promise<Row> {
    const { data, error } = await this.db().from("tasks")
      .select(`${this.taskSelect()}, work_type:work_types(code, name), reason:task_reasons(code, name), equipment_full:equipment!equipment_id(${EQUIPMENT_SELECT})`)
      .eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Задача не найдена");
    return asRow(data);
  }

  private async loadEquipment(id: string): Promise<EquipmentApiRecord> {
    const { data, error } = await this.db().from("equipment").select(EQUIPMENT_SELECT).eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Прибор не найден");
    return mapEquipment(asRow(data));
  }



  /** Подписанные ссылки на файлы живут час; держим их 30 минут, чтобы у показанной ссылки оставалось не меньше получаса. */
  private readonly signedUrlCache = new Map<string, { readonly url: string; readonly until: number }>();

  /** Ссылки на файлы по ключам хранилища: из памяти, недостающие одним запросом. */
  public async signedFileUrls(keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const now = Date.now();
    const result = new Map<string, string>();
    const missing: string[] = [];
    for (const key of new Set(keys.filter(Boolean))) {
      const cached = this.signedUrlCache.get(key);
      if (cached && cached.until > now) result.set(key, cached.url);
      else missing.push(key);
    }
    if (missing.length) {
      const { data } = await this.db().storage.from("medtech-files").createSignedUrls(missing, 3600);
      for (const item of data ?? []) {
        if (!item.path || !item.signedUrl) continue;
        result.set(item.path, item.signedUrl);
        this.signedUrlCache.set(item.path, { url: item.signedUrl, until: now + 30 * 60_000 });
      }
    }
    return result;
  }

  private visibleFileRows(rows: readonly unknown[] | null, canSeeFinance: boolean): Row[] {
    return (rows ?? []).map(asRow).filter((row) => !(row.is_financial === true && !canSeeFinance));
  }

  /** Файлы для экрана: ссылка, если она уже есть в памяти; ключ хранилища, чтобы галерея подписала остальные. */
  private fileRecords(rows: readonly Row[]): EquipmentFileResponse[] {
    const now = Date.now();
    return rows.map((row) => {
      const key = text(row, "storage_key");
      const cached = key ? this.signedUrlCache.get(key) : undefined;
      return {
        id: text(row, "id"),
        kind: text(row, "kind") || "document",
        originalName: text(row, "original_name"),
        contentType: text(row, "content_type") || "application/octet-stream",
        byteSize: numberValue(row.byte_size) ?? 0,
        createdAt: iso(row.created_at),
        equipmentId: optionalText(row, "equipment_id"),
        url: cached && cached.until > now ? cached.url : undefined,
        ...(key ? { storageKey: key } : {})
      };
    });
  }

  /** Файлы со ссылками: недостающие подписываем сейчас, одним запросом. */
  private async mapFiles(rows: readonly unknown[] | null, canSeeFinance: boolean): Promise<EquipmentFileResponse[]> {
    const visible = this.visibleFileRows(rows, canSeeFinance);
    await this.signedFileUrls(visible.map((row) => text(row, "storage_key")));
    return this.fileRecords(visible);
  }

  /** Файлы без ожидания ссылок: экран показывается сразу, превью подгрузит галерея. */
  private mapFilesLazy(rows: readonly unknown[] | null, canSeeFinance: boolean): EquipmentFileResponse[] {
    return this.fileRecords(this.visibleFileRows(rows, canSeeFinance));
  }

  private sessionCache: { readonly userId: string; readonly at: number; readonly value: Promise<ApiSessionUser> } | undefined;
  /** Справочники меняются редко: держим 5 минут, сбрасываем при правке справочника, входе и выходе. */
  private readonly catalogCache = new Map<string, { readonly at: number; readonly value: Promise<readonly ReferenceCatalogValue[]> }>();

  /** Мой профиль: почта и номер чата Telegram вошедшего сотрудника. */
  public async myProfile(): Promise<{ readonly email?: string; readonly telegramChatId?: string }> {
    const session = await this.cachedSession();
    const { data, error } = await this.db().from("users").select("email, telegram_chat_id").eq("id", session.id).maybeSingle();
    throwIfError(error, "Не получилось загрузить профиль");
    const row = asRow(data);
    const email = optionalText(row, "email");
    const telegramChatId = optionalText(row, "telegram_chat_id");
    return { ...(email ? { email } : {}), ...(telegramChatId ? { telegramChatId } : {}) };
  }

  /**
   * Свой номер чата Telegram сотрудник вписывает сам (миграция 0021): бот отвечает номером на /start.
   * Пусто убирает Telegram. Менять так можно только свой номер, чужие меняет администратор.
   */
  public async setMyTelegramChatId(value: string): Promise<string | undefined> {
    const chat = ownTelegramChatId(value);
    const { data, error } = await this.db().rpc("set_my_telegram_chat_id", { p_chat_id: chat ?? "" });
    if (error && (error as { readonly code?: string }).code === "PGRST202") {
      throw new M2ApiError(501, "Сохранение номера заработает после обновления базы. Пока номер вписывает администратор в разделе «Сотрудники»");
    }
    throwIfError(error, "Не получилось сохранить номер чата");
    return typeof data === "string" && data ? data : undefined;
  }

  /** Есть ли у текущего пользователя право (из памяти, без лишнего запроса). */
  public async hasPermission(permission: string): Promise<boolean> {
    const session = await this.cachedSession();
    return session.permissions?.includes(permission) === true;
  }

  /** Права текущего пользователя для экранов: из памяти, если вход тот же и прошло меньше минуты. */
  private async cachedSession(): Promise<ApiSessionUser> {
    const { data } = await this.db().auth.getSession();
    const userId = data.session?.user.id;
    const cached = this.sessionCache;
    if (userId && cached && cached.userId === userId && Date.now() - cached.at < 60_000) return cached.value;
    const value = this.session();
    if (userId) this.sessionCache = { userId, at: Date.now(), value };
    value.catch(() => { if (this.sessionCache?.value === value) this.sessionCache = undefined; });
    return value;
  }

  public async session(): Promise<ApiSessionUser> {
    // Вход проверяет сервер (getUser), а профиль читаем параллельно по id из сохранённого входа.
    const { data: localData } = await this.db().auth.getSession();
    const localUserId = localData.session?.user.id;
    // Права роли приходят вместе с профилем, одним запросом, а не вторым шагом.
    const profileFields = "id, full_name, role, email, is_active, access_role_key, access_role:access_roles(key, name, base_role";
    const profileQuery = async (userId: string) => {
      const withPermissions = await this.db().from("users")
        .select(`${profileFields}, permissions:access_role_permissions(permission_code))`)
        .eq("id", userId).maybeSingle();
      if (!withPermissions.error) return withPermissions;
      return this.db().from("users").select(`${profileFields})`).eq("id", userId).maybeSingle();
    };
    const [auth, profileGuess] = await Promise.all([
      this.db().auth.getUser(),
      localUserId ? profileQuery(localUserId) : Promise.resolve(undefined)
    ]);
    throwIfError(auth.error, "Не удалось прочитать сессию");
    if (!auth.data.user) throw new M2ApiError(401, "Нужна сессия");
    const userId = auth.data.user.id;
    const profile = profileGuess && localUserId === userId ? profileGuess : await profileQuery(userId);
    throwIfError(profile.error);
    if (!profile.data) throw new M2ApiError(403, "Профиль пользователя не найден");
    const row = asRow(profile.data);
    const accessRole = related(row, "access_role");
    const roleKey = optionalText(row, "access_role_key") ?? text(row, "role");
    // Без своей роли доступа (только базовая роль) или без вложенных прав: читаем права отдельно.
    const embedded = optionalText(accessRole, "key") === roleKey && Array.isArray(accessRole.permissions) ? accessRole.permissions : undefined;
    let permissionRows: readonly unknown[] | null = embedded ?? null;
    if (!embedded) {
      const separate = await this.db().from("access_role_permissions").select("permission_code").eq("role_key", roleKey);
      throwIfError(separate.error);
      permissionRows = separate.data;
    }
    const result: ApiSessionUser = {
      id: text(row, "id"),
      fullName: text(row, "full_name"),
      role: optionalText(accessRole, "base_role") ?? text(row, "role"),
      accessRoleKey: roleKey,
      accessRoleName: optionalText(accessRole, "name"),
      permissions: (permissionRows ?? []).map((item) => text(asRow(item), "permission_code"))
    };
    // Права уже проверены сервером: экраны в течение минуты берут их из памяти.
    this.sessionCache = { userId, at: Date.now(), value: Promise.resolve(result) };
    return result;
  }

  public async login(email: string, password: string): Promise<ApiSessionUser> {
    this.sessionCache = undefined;
    this.catalogCache.clear();
    // Ссылки на файлы прежнего входа другому пользователю не достаются.
    this.signedUrlCache.clear();
    const { error } = await this.db().auth.signInWithPassword({ email, password });
    throwIfError(error, "Неверный e-mail или пароль");
    return this.session();
  }

  public async logout(): Promise<void> {
    this.sessionCache = undefined;
    this.catalogCache.clear();
    // Ссылки на файлы прежнего входа другому пользователю не достаются.
    this.signedUrlCache.clear();
    const { error } = await this.db().auth.signOut();
    throwIfError(error);
  }

  public async accessRoles(): Promise<{ readonly items: readonly AccessRoleResponse[]; readonly permissions: readonly Permission[] }> {
    const { data, error } = await this.db().from("access_roles").select("key, name, base_role, is_builtin, is_active, created_at, updated_at, access_role_permissions(permission_code)").order("name");
    throwIfError(error);
    const { data: permissionRows, error: permissionError } = await this.db().from("permissions").select("code");
    throwIfError(permissionError);
    return {
      items: (data ?? []).map((item) => {
        const row = asRow(item);
        const nested = row.access_role_permissions;
        const permissions = Array.isArray(nested) ? nested.map((entry) => text(asRow(entry), "permission_code") as Permission) : [];
        return {
          key: text(row, "key"),
          name: text(row, "name"),
          baseRole: text(row, "base_role") as WorkingRole,
          permissions,
          builtIn: row.is_builtin === true,
          isActive: row.is_active !== false,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        };
      }),
      permissions: (permissionRows ?? []).map((item) => text(asRow(item), "code") as Permission)
    };
  }

  public async createAccessRole(input: Readonly<Record<string, unknown>>): Promise<AccessRoleResponse> {
    const { data, error } = await this.db().from("access_roles").insert({
      key: input.key,
      name: input.name,
      base_role: input.baseRole ?? input.base_role,
      is_active: input.isActive !== false
    }).select("key, name, base_role, is_builtin, is_active, created_at, updated_at").single();
    throwIfError(error);
    const created = asRow(data);
    const permissions = Array.isArray(input.permissions) ? input.permissions as readonly string[] : [];
    if (permissions.length) {
      const { error: permError } = await this.db().from("access_role_permissions").insert(permissions.map((code) => ({ role_key: created.key, permission_code: code })));
      throwIfError(permError);
    }
    return {
      key: text(created, "key"),
      name: text(created, "name"),
      baseRole: text(created, "base_role") as WorkingRole,
      permissions: permissions as Permission[],
      builtIn: false,
      isActive: created.is_active !== false,
      createdAt: iso(created.created_at),
      updatedAt: iso(created.updated_at)
    };
  }

  public async updateAccessRole(key: string, input: Readonly<Record<string, unknown>>): Promise<AccessRoleResponse> {
    const patch: Row = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (Object.keys(patch).length) {
      const { error } = await this.db().from("access_roles").update(patch).eq("key", key);
      throwIfError(error);
    }
    if (Array.isArray(input.permissions)) {
      const { error: delError } = await this.db().from("access_role_permissions").delete().eq("role_key", key);
      throwIfError(delError);
      const permissions = input.permissions as readonly string[];
      if (permissions.length) {
        const { error: insError } = await this.db().from("access_role_permissions").insert(permissions.map((code) => ({ role_key: key, permission_code: code })));
        throwIfError(insError);
      }
    }
    const roles = await this.accessRoles();
    const role = roles.items.find((item) => item.key === key);
    if (!role) throw new M2ApiError(404, "Роль не найдена");
    return role;
  }

  public async accessUsers(): Promise<readonly AccessUserRecord[]> {
    const { data, error } = await this.db().from("users").select("id, full_name, role, email, is_active, access_role_key, telegram_chat_id").order("full_name");
    throwIfError(error);
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return {
        id: text(row, "id"),
        fullName: text(row, "full_name"),
        role: text(row, "role"),
        email: text(row, "email"),
        isActive: row.is_active !== false,
        accessRoleKey: optionalText(row, "access_role_key"),
        ...(optionalText(row, "telegram_chat_id") ? { telegramChatId: optionalText(row, "telegram_chat_id") } : {})
      };
    });
  }

  public async createAccessUser(input: Readonly<Record<string, unknown>>): Promise<AccessUserRecord> {
    const email = String(input.email ?? "").trim();
    const password = String(input.password ?? "");
    const fullName = String(input.fullName ?? input.full_name ?? "").trim();
    const accessRoleKey = String(input.accessRoleKey ?? input.role ?? "").trim();
    const organizationIds = Array.isArray(input.organizationIds)
      ? input.organizationIds.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const telegramChatId = normalizeTelegramChatId(input.telegramChatId);
    const { data, error } = await this.db().rpc("create_access_user", {
      p_email: email,
      p_password: password,
      p_full_name: fullName,
      p_access_role_key: accessRoleKey,
      p_organization_ids: organizationIds.length ? organizationIds : null
    });
    throwIfError(error, "Не удалось создать учётную запись");
    const row = asRow(data);
    const userId = text(row, "id");
    if (!userId) throw new M2ApiError(400, "Supabase не вернул идентификатор пользователя");
    if (telegramChatId) {
      const { error: telegramError } = await this.db().from("users").update({ telegram_chat_id: telegramChatId }).eq("id", userId);
      throwIfError(telegramError, "Сотрудник создан, но номер чата Telegram не сохранён");
    }
    return {
      id: userId,
      fullName: text(row, "full_name") || fullName,
      role: text(row, "role") || String(input.role ?? ""),
      email: text(row, "email") || email,
      isActive: row.is_active !== false,
      accessRoleKey: optionalText(row, "access_role_key") ?? accessRoleKey,
      ...(telegramChatId ? { telegramChatId } : {})
    };
  }

  public async updateAccessUser(id: string, input: Readonly<Record<string, unknown>>): Promise<AccessUserRecord> {
    const patch: Row = {};
    if (input.fullName !== undefined) patch.full_name = input.fullName;
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.accessRoleKey !== undefined) patch.access_role_key = input.accessRoleKey;
    if (input.telegramChatId !== undefined) patch.telegram_chat_id = normalizeTelegramChatId(input.telegramChatId);
    const { data, error } = await this.db().from("users").update(patch).eq("id", id).select("id, full_name, role, email, is_active, access_role_key, telegram_chat_id").single();
    throwIfError(error);
    const row = asRow(data);
    return {
      id: text(row, "id"),
      fullName: text(row, "full_name"),
      role: text(row, "role"),
      email: text(row, "email"),
      isActive: row.is_active !== false,
      accessRoleKey: optionalText(row, "access_role_key"),
      ...(optionalText(row, "telegram_chat_id") ? { telegramChatId: optionalText(row, "telegram_chat_id") } : {})
    };
  }

  public async notifications(query: {
    readonly channel?: string;
    readonly status?: string;
    readonly eventCode?: string;
    readonly recipient?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<NotificationJournalResponse> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    let request = this.db().from("notifications").select("id, event_code, recipient_user_id, channel, recipient_address, subject, body, status, scheduled_at, sent_at, delivered_at, attempts, last_error, task_id, created_at", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (query.channel) request = request.eq("channel", query.channel);
    if (query.status) request = request.eq("status", query.status);
    if (query.eventCode) request = request.eq("event_code", query.eventCode);
    // Фильтр «Адресат» раньше не уходил в запрос: ищем по адресу получателя.
    const recipient = query.recipient ? escapeIlikePattern(query.recipient.trim()) : "";
    if (recipient) request = request.ilike("recipient_address", `%${recipient}%`);
    const { data, error, count } = await request;
    throwIfError(error);
    return {
      items: (data ?? []).map((item) => {
        const row = asRow(item);
        return {
          id: text(row, "id"),
          eventCode: text(row, "event_code"),
          recipientUserId: optionalText(row, "recipient_user_id"),
          channel: text(row, "channel") as NotificationJournalResponse["items"][number]["channel"],
          recipientAddress: text(row, "recipient_address"),
          subject: text(row, "subject"),
          body: text(row, "body"),
          status: text(row, "status") as NotificationJournalResponse["items"][number]["status"],
          scheduledAt: iso(row.scheduled_at),
          sentAt: optionalText(row, "sent_at"),
          deliveredAt: optionalText(row, "delivered_at"),
          attempts: numberValue(row.attempts) ?? 0,
          lastError: optionalText(row, "last_error"),
          taskId: optionalText(row, "task_id"),
          createdAt: iso(row.created_at)
        };
      }),
      total: count ?? 0,
      limit,
      offset
    };
  }

  public async notificationTemplates(): Promise<readonly NotificationTemplateResponse[]> {
    const { data, error } = await this.db().from("notification_templates").select("code, name, subject_template, body_template, is_active, updated_at").order("name");
    throwIfError(error);
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return {
        code: text(row, "code"),
        name: text(row, "name"),
        subjectTemplate: text(row, "subject_template"),
        bodyTemplate: text(row, "body_template"),
        allowedVariables: [],
        isActive: row.is_active !== false,
        updatedAt: iso(row.updated_at)
      };
    });
  }

  public async updateNotificationTemplate(code: string, input: UpdateNotificationTemplateRequest): Promise<NotificationTemplateResponse> {
    const { data, error } = await this.db().from("notification_templates").update({
      subject_template: input.subjectTemplate,
      body_template: input.bodyTemplate,
      is_active: input.isActive
    }).eq("code", code).select("code, name, subject_template, body_template, is_active, updated_at").single();
    throwIfError(error);
    const row = asRow(data);
    return {
      code: text(row, "code"),
      name: text(row, "name"),
      subjectTemplate: text(row, "subject_template"),
      bodyTemplate: text(row, "body_template"),
      allowedVariables: [],
      isActive: row.is_active !== false,
      updatedAt: iso(row.updated_at)
    };
  }

  public async equipmentPage(query: {
    readonly limit?: number;
    readonly offset?: number;
    readonly search?: string;
    readonly manufacturer?: string;
    readonly status?: string;
    readonly site?: string;
    readonly payer?: string;
  } = {}): Promise<ApiPage<EquipmentApiRecord>> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    let request = this.db().from("equipment").select(EQUIPMENT_SELECT, { count: "exact" }).order("serial_number").range(offset, offset + limit - 1);
    if (query.status) request = request.eq("status_code", query.status);
    if (query.site) {
      const siteId = await this.resolveFilterId("sites", query.site);
      if (!siteId) return paged([], 0, limit, offset);
      request = request.eq("current_site_id", siteId);
    }
    if (query.payer) {
      const payerId = await this.resolveFilterId("payers", query.payer);
      if (!payerId) return paged([], 0, offset, offset);
      request = request.eq("current_payer_id", payerId);
    }
    if (query.manufacturer) {
      const manufacturerId = await this.resolveFilterId("manufacturers", query.manufacturer);
      if (!manufacturerId) return paged([], 0, offset, offset);
      request = request.eq("manufacturer_id", manufacturerId);
    }
    if (query.search?.trim()) {
      const term = escapePostgrestSearchTerm(query.search);
      if (term) {
        request = request.or(
          [`serial_number.ilike.%${term}%`, `notes.ilike.%${term}%`].join(",")
        );
      }
    }
    const { data, error, count } = await request;
    // Старый Select мог прислать подпись вместо uuid — не роняем список, показываем пусто.
    if (error && /invalid input syntax for type uuid|22P02/iu.test(error.message)) {
      return paged([], 0, limit, offset);
    }
    throwIfError(error);
    return paged((data ?? []).map((item) => mapEquipment(asRow(item))), count ?? 0, offset, offset);
  }

  /** Фильтр мог прийти id или отображаемым именем (старый Select без value). */
  private async resolveFilterId(
    table: "manufacturers" | "sites" | "payers",
    value: string | undefined
  ): Promise<string | undefined> {
    const raw = normalizeFilterValue(value);
    if (!raw) return undefined;
    if (isFilterUuid(raw)) return raw;
    const { data, error } = await this.db().from(table).select("id").ilike("name", escapeIlikePattern(raw)).limit(1);
    // Ошибка справочника не должна ронять весь список приборов.
    if (error) return undefined;
    return optionalText(asRow(data?.[0]), "id");
  }

  public async listEquipment(): Promise<readonly EquipmentApiRecord[]> {
    const items: EquipmentApiRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.equipmentPage({ limit: 100, offset });
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) return items;
    }
  }

  public async searchEquipmentBySerial(serialNumber: string): Promise<readonly EquipmentApiRecord[]> {
    return (await this.equipmentPage({ search: serialNumber, limit: 20 })).items;
  }

  public async equipmentHistoryPage(id: string, offset: number, limit = 25): Promise<ApiPage<EquipmentHistoryEvent>> {
    const { data, error, count } = await this.db()
      .from("equipment_history_feed")
      .select("event_id, equipment_id, happened_at, event_type, summary, details, task_id, created_at, created_by, created_by_name", { count: "exact" })
      .eq("equipment_id", id)
      .order("happened_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwIfError(error);
    const items = (data ?? []).map((item) => {
      const row = asRow(item);
      const details = asRow(row.details);
      const rawType = text(row, "event_type");
      const eventType = (rawType === "part_movement" ? "part_replacement" : rawType) as EquipmentHistoryEventType;
      const previousName = optionalText(details, "previousValue");
      const newName = optionalText(details, "newValue");
      const comment = optionalText(details, "comment");
      return {
        id: text(row, "event_id"),
        equipmentId: text(row, "equipment_id"),
        occurredAt: iso(row.happened_at),
        recordedAt: iso(row.created_at),
        eventType,
        summary: text(row, "summary"),
        client: text(details, "client"),
        description: optionalText(details, "description") ?? comment ?? "",
        source: { kind: eventType, id: optionalText(row, "event_id") },
        taskId: optionalText(row, "task_id"),
        ...(previousName ? {
          previousValue: {
            ...(optionalText(details, "previousValueId") ? { id: text(details, "previousValueId") } : {}),
            name: previousName
          }
        } : {}),
        ...(newName ? {
          newValue: {
            ...(optionalText(details, "newValueId") ? { id: text(details, "newValueId") } : {}),
            name: newName
          }
        } : {}),
        ...(comment ? { comment } : {}),
        author: optionalText(row, "created_by_name") ? { id: optionalText(row, "created_by"), name: text(row, "created_by_name") } : undefined
      } satisfies EquipmentHistoryEvent;
    });
    return paged(items, count ?? 0, limit, offset);
  }

  public async equipmentMeterReadingsPage(id: string, offset: number, limit = 25): Promise<ApiPage<EquipmentMeterReading>> {
    const { data, error, count } = await this.db()
      .from("equipment_meter_readings")
      .select("id, equipment_id, reading, measured_at, task_id, created_by, created_by_name, author:users!created_by(full_name)", { count: "exact" })
      .eq("equipment_id", id)
      .order("measured_at", { ascending: false })
      .range(offset, offset + limit - 1);
    throwIfError(error);
    return paged((data ?? []).map((item) => {
      const row = asRow(item);
      const authorName = optionalText(row, "created_by_name") ?? optionalText(related(row, "author"), "full_name") ?? "Система";
      const value = numberValue(row.reading) ?? 0;
      const measuredAt = iso(row.measured_at);
      return {
        id: text(row, "id"),
        equipmentId: text(row, "equipment_id"),
        value,
        reading: value,
        recordedAt: measuredAt,
        measuredAt,
        taskId: optionalText(row, "task_id"),
        author: { name: authorName }
      };
    }), count ?? 0, limit, offset);
  }

  /** Открытые задачи по прибору, запрошенные вместе с паспортом: паспорт берёт их без второй волны запросов. */
  private readonly equipmentTasksPrefetch = new Map<string, { readonly at: number; readonly value: Promise<readonly TaskApiRecord[]> }>();

  /** Открытые задачи прибора для паспорта: уже запрошенные вместе с паспортом или новым запросом. */
  public equipmentOpenTasks(id: string): Promise<readonly TaskApiRecord[]> {
    const prefetched = this.equipmentTasksPrefetch.get(id);
    this.equipmentTasksPrefetch.delete(id);
    if (prefetched && Date.now() - prefetched.at < 15_000) return prefetched.value;
    return this.tasksPage({ equipmentId: id, openOnly: true, limit: 20, sort: "deadline_asc" }).then((page) => page.items);
  }

  public async equipmentCard(id: string, options: { readonly prefetchOpenTasks?: boolean } = {}): Promise<EquipmentCardResponse> {
    // Открытые задачи прибора запрашиваем сразу, вместе с паспортом, а не после его показа.
    // Обновлению уже открытого паспорта они не нужны: список задач там уже показан.
    if (options.prefetchOpenTasks !== false) {
      const openTasks = this.tasksPage({ equipmentId: id, openOnly: true, limit: 20, sort: "deadline_asc" }).then((page) => page.items);
      openTasks.catch(() => undefined);
      this.equipmentTasksPrefetch.set(id, { at: Date.now(), value: openTasks });
    }
    // Всё одним шагом: права берём из памяти (как у карточки задачи), а не новыми тремя запросами.
    const [passport, history, meterReadings, filesResult, session] = await Promise.all([
      this.loadEquipment(id),
      this.equipmentHistoryPage(id, 0, 25),
      this.equipmentMeterReadingsPage(id, 0, 25),
      this.db().from("files").select(FILE_SELECT).eq("equipment_id", id).order("created_at", { ascending: false }),
      this.cachedSession()
    ]);
    throwIfError(filesResult.error);
    return {
      passport,
      history,
      meterReadings,
      // Паспорт показывается сразу, превью файлов подгрузит галерея.
      files: this.mapFilesLazy(filesResult.data, session.permissions?.includes("finance.read") === true)
    };
  }

  public async passportReferences(): Promise<EquipmentPassportReferences> {
    const [manufacturers, models, categories, statuses] = await Promise.all([
      this.db().from("manufacturers").select("id, name").eq("is_active", true).order("sort_order").order("name"),
      this.db().from("equipment_models").select("id, name, manufacturer_id").eq("is_active", true).order("sort_order").order("name"),
      this.db().from("guarantee_categories").select("id, code, name").eq("is_active", true).order("sort_order").order("name"),
      this.db().from("equipment_statuses").select("code, name").order("sort_order")
    ]);
    throwIfError(manufacturers.error);
    throwIfError(models.error);
    throwIfError(categories.error);
    throwIfError(statuses.error);
    return {
      manufacturers: (manufacturers.data ?? []).map((item) => ({ id: text(asRow(item), "id"), name: text(asRow(item), "name") })),
      models: (models.data ?? []).map((item) => ({ id: text(asRow(item), "id"), name: text(asRow(item), "name"), manufacturerId: text(asRow(item), "manufacturer_id") })),
      guaranteeCategories: (categories.data ?? []).map((item) => ({ id: text(asRow(item), "id"), code: text(asRow(item), "code"), name: text(asRow(item), "name") })),
      statuses: (statuses.data ?? []).map((item) => ({ code: text(asRow(item), "code"), name: text(asRow(item), "name") }))
    };
  }

  public async createEquipment(input: Readonly<Record<string, unknown>>): Promise<EquipmentApiRecord> {
    const { data, error } = await this.db().from("equipment").insert({
      serial_number: input.serialNumber,
      manufacturer_id: input.manufacturerId,
      model_id: input.modelId,
      guarantee_category_id: input.guaranteeCategoryId ?? null,
      status_code: input.status ?? "in_use",
      notes: input.notes ?? null
    }).select("id").single();
    throwIfError(error);
    const id = text(asRow(data), "id");
    const siteId = typeof input.siteId === "string" ? input.siteId.trim() : "";
    const payerId = typeof input.payerId === "string" ? input.payerId.trim() : "";
    const happenedAt = new Date().toISOString();
    if (siteId) {
      await this.changeEquipmentAssignment(id, "site_change", {
        targetId: siteId,
        occurredAt: happenedAt,
        comment: "Площадка при создании прибора"
      });
    }
    if (payerId) {
      await this.changeEquipmentAssignment(id, "payer_change", {
        targetId: payerId,
        occurredAt: happenedAt,
        comment: "Плательщик при создании прибора"
      });
    }
    return this.loadEquipment(id);
  }

  public async updateEquipment(id: string, input: Readonly<Record<string, unknown>>): Promise<EquipmentApiRecord> {
    const patch: Row = {};
    if (input.serialNumber !== undefined) patch.serial_number = input.serialNumber;
    if (input.manufacturerId !== undefined) patch.manufacturer_id = input.manufacturerId;
    if (input.modelId !== undefined) patch.model_id = input.modelId;
    if (input.guaranteeCategoryId !== undefined) patch.guarantee_category_id = input.guaranteeCategoryId;
    if (input.status !== undefined) patch.status_code = input.status;
    if (input.notes !== undefined) patch.notes = input.notes;
    const { error } = await this.db().from("equipment").update(patch).eq("id", id);
    throwIfError(error);
    return this.loadEquipment(id);
  }

  public async changeEquipmentAssignment(
    id: string,
    kind: "site_change" | "payer_change",
    input: { readonly targetId: string; readonly occurredAt: string; readonly comment: string }
  ): Promise<EquipmentApiRecord> {
    const actor = await this.actorId();
    const fn = kind === "site_change" ? "change_equipment_site" : "change_equipment_payer";
    const args = kind === "site_change"
      ? { p_equipment_id: id, p_new_site_id: input.targetId, p_happened_at: input.occurredAt, p_comment: input.comment, p_changed_by: actor }
      : { p_equipment_id: id, p_new_payer_id: input.targetId, p_happened_at: input.occurredAt, p_comment: input.comment, p_changed_by: actor };
    const { error } = await this.db().rpc(fn, args);
    throwIfError(error);
    return this.loadEquipment(id);
  }

  public async addEquipmentHistory(id: string, input: Readonly<Record<string, unknown>>): Promise<EquipmentHistoryEvent> {
    const actor = await this.actorId();
    const { data, error } = await this.db().from("equipment_history").insert({
      equipment_id: id,
      event_type: "manual",
      happened_at: input.occurredAt,
      summary: input.summary,
      details: { client: input.client ?? "", description: input.description ?? "" },
      created_by: actor
    }).select("id, equipment_id, happened_at, summary, details, created_at").single();
    throwIfError(error);
    const row = asRow(data);
    const details = asRow(row.details);
    return {
      id: text(row, "id"),
      equipmentId: text(row, "equipment_id"),
      occurredAt: iso(row.happened_at),
      recordedAt: iso(row.created_at),
      eventType: "manual",
      summary: text(row, "summary"),
      client: text(details, "client"),
      description: text(details, "description"),
      source: { kind: "manual", id: text(row, "id") }
    };
  }

  public async uploadEquipmentFiles(id: string, files: readonly File[]): Promise<void> {
    const actor = await this.actorId();
    for (const file of files) {
      const key = `${id}/${storageObjectName(file.name)}`;
      const { error: storageError } = await this.db().storage.from("medtech-files").upload(key, file, { contentType: file.type || "application/octet-stream", upsert: false });
      throwIfError(storageError, "Не удалось загрузить файл");
      const { error } = await this.db().from("files").insert({
        kind: "document",
        equipment_id: id,
        storage_key: key,
        original_name: file.name,
        content_type: file.type || "application/octet-stream",
        byte_size: file.size,
        uploaded_by: actor,
        is_financial: false
      });
      throwIfError(error);
    }
  }

  /** Лёгкий список площадок (id и название) для фильтров. */
  public async listSiteNames(): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const { data, error } = await this.db().from("sites").select("id, name").eq("is_active", true).order("name");
    throwIfError(error);
    return (data ?? []).map((item) => ({ id: text(asRow(item), "id"), name: text(asRow(item), "name") }));
  }

  public async listSites(includeInactive = false): Promise<readonly SiteOption[]> {
    const selectFull = "id, name, address, type, is_active, organization_id, notes, site_contacts(id, full_name, phone, email, position, is_primary, is_active, payer_id, payer:payers!payer_id(id, name, is_active, requisites)), site_payers(payers(id, name, is_active, requisites))";
    const selectWithSitePayers = "id, name, address, type, is_active, organization_id, notes, site_contacts(id, full_name, phone, email, position, is_primary, is_active), site_payers(payers(id, name, is_active, requisites))";
    const selectBasic = "id, name, address, type, is_active, organization_id, notes, site_contacts(id, full_name, phone, email, position, is_primary, is_active)";
    const load = async (select: string) => {
      let request = this.db().from("sites").select(select).order("name");
      if (!includeInactive) request = request.eq("is_active", true);
      return request;
    };
    let primary = await load(selectFull);
    let rows: readonly unknown[] = primary.data ?? [];
    let loadError = primary.error;
    if (loadError && /payer_id|site_contacts_payer|payers!payer_id/i.test(loadError.message)) {
      primary = await load(selectWithSitePayers);
      rows = primary.data ?? [];
      loadError = primary.error;
    }
    if (loadError && /site_payers/i.test(loadError.message)) {
      const secondary = await load(selectBasic);
      rows = secondary.data ?? [];
      loadError = secondary.error;
    }
    throwIfError(loadError);
    return rows.map((item) => {
      const row = asRow(item);
      const contacts = Array.isArray(row.site_contacts) ? row.site_contacts : [];
      const sitePayers = Array.isArray(row.site_payers) ? row.site_payers : [];
      const payersFromLinks = sitePayers.flatMap((link) => {
        const payer = asRow(asRow(link).payers);
        if (!payer.id) return [];
        return [mapPayerOption(payer)];
      });
      const payerById = new Map(payersFromLinks.map((payer) => [payer.id, payer]));
      return {
        id: text(row, "id"),
        name: text(row, "name"),
        address: text(row, "address"),
        type: text(row, "type") === "group_company" ? "group_company" : "medical_facility",
        isActive: row.is_active !== false,
        ...(optionalText(row, "notes") ? { notes: text(row, "notes") } : {}),
        contacts: contacts.map((contact) => {
          const contactRow = asRow(contact);
          const linkedPayer = mapOptionalPayer(contactRow.payer);
          if (linkedPayer) payerById.set(linkedPayer.id, linkedPayer);
          return {
            id: text(contactRow, "id"),
            fullName: text(contactRow, "full_name"),
            phone: optionalText(contactRow, "phone"),
            email: optionalText(contactRow, "email"),
            isPrimary: contactRow.is_primary === true,
            isActive: contactRow.is_active !== false,
            ...(optionalText(contactRow, "payer_id") ? { payerId: text(contactRow, "payer_id") } : linkedPayer ? { payerId: linkedPayer.id } : {}),
            ...(linkedPayer?.inn ? { inn: linkedPayer.inn } : {}),
            ...(linkedPayer?.kpp ? { kpp: linkedPayer.kpp } : {})
          };
        }),
        payers: [...payerById.values()]
      };
    });
  }

  public async listPayers(includeInactive = false): Promise<readonly PayerOption[]> {
    let request = this.db().from("payers").select("id, name, is_active, requisites").order("name");
    if (!includeInactive) request = request.eq("is_active", true);
    const { data, error } = await request;
    throwIfError(error);
    return (data ?? []).map((item) => mapPayerOption(asRow(item)));
  }

  public async linkPayerToSite(siteId: string, payerId: string): Promise<void> {
    const { error } = await this.db().from("site_payers").upsert({ site_id: siteId, payer_id: payerId }, { onConflict: "site_id,payer_id" });
    throwIfError(error);
  }

  public async unlinkPayerFromSite(siteId: string, payerId: string): Promise<void> {
    const { error } = await this.db().from("site_payers").delete().eq("site_id", siteId).eq("payer_id", payerId);
    throwIfError(error);
  }

  public async createSite(input: Readonly<Record<string, unknown>>): Promise<SiteOption> {
    const { data, error } = await this.db().from("sites").insert({
      name: input.name,
      address: input.address ?? "",
      type: input.type ?? "medical_facility",
      organization_id: input.organizationId ?? null,
      notes: input.notes ?? null
    }).select("id").single();
    throwIfError(error);
    const sites = await this.listSites(true);
    const created = sites.find((site) => site.id === text(asRow(data), "id"));
    if (!created) throw new M2ApiError(500, "Площадка не создана");
    return created;
  }

  public async updateSite(id: string, input: Readonly<Record<string, unknown>>): Promise<SiteOption> {
    const patch: Row = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.address !== undefined) patch.address = input.address;
    if (input.type !== undefined) patch.type = input.type;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    const { error } = await this.db().from("sites").update(patch).eq("id", id);
    throwIfError(error);
    const site = (await this.listSites(true)).find((item) => item.id === id);
    if (!site) throw new M2ApiError(404, "Площадка не найдена");
    return site;
  }

  public async removeSite(id: string): Promise<{ readonly mode: "deactivated"; readonly after: SiteOption }> {
    return { mode: "deactivated", after: await this.updateSite(id, { isActive: false }) };
  }

  public async createContact(siteId: string, input: Readonly<Record<string, unknown>>): Promise<SiteOption["contacts"][number]> {
    const payload: Row = {
      site_id: siteId,
      full_name: input.fullName ?? input.full_name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      position: input.position ?? null,
      is_primary: input.isPrimary === true
    };
    if (input.payerId !== undefined) payload.payer_id = input.payerId || null;
    let { data, error } = await this.db().from("site_contacts").insert(payload).select("id, full_name, phone, email, position, is_primary, is_active, payer_id").single();
    if (error && /payer_id/i.test(error.message)) {
      delete payload.payer_id;
      ({ data, error } = await this.db().from("site_contacts").insert(payload).select("id, full_name, phone, email, position, is_primary, is_active").single());
    }
    throwIfError(error);
    return mapContactOption(asRow(data));
  }

  public async updateContact(_siteId: string, contactId: string, input: Readonly<Record<string, unknown>>): Promise<SiteOption["contacts"][number]> {
    const patch: Row = {};
    if (input.fullName !== undefined) patch.full_name = input.fullName;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.email !== undefined) patch.email = input.email;
    if (input.position !== undefined) patch.position = input.position;
    if (input.isPrimary !== undefined) patch.is_primary = input.isPrimary;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.payerId !== undefined) patch.payer_id = input.payerId || null;
    let { data, error } = await this.db().from("site_contacts").update(patch).eq("id", contactId).select("id, full_name, phone, email, position, is_primary, is_active, payer_id").single();
    if (error && /payer_id/i.test(error.message)) {
      delete patch.payer_id;
      ({ data, error } = await this.db().from("site_contacts").update(patch).eq("id", contactId).select("id, full_name, phone, email, position, is_primary, is_active").single());
    }
    throwIfError(error);
    return mapContactOption(asRow(data));
  }

  public async removeContact(siteId: string, contactId: string): Promise<{ readonly mode: "deactivated"; readonly after: SiteOption["contacts"][number] }> {
    return { mode: "deactivated", after: await this.updateContact(siteId, contactId, { isActive: false }) };
  }

  /** Единый человек площадки: контакт + плательщик с теми же ФИО/реквизитами. */
  public async createSitePerson(siteId: string, input: {
    readonly fullName: string;
    readonly phone?: string;
    readonly email?: string;
    readonly inn?: string;
    readonly kpp?: string;
  }): Promise<void> {
    const payer = await this.createPayer({
      name: input.fullName,
      requisites: {
        ...(input.inn ? { inn: input.inn } : {}),
        ...(input.kpp ? { kpp: input.kpp } : {})
      },
      siteId
    });
    await this.createContact(siteId, {
      fullName: input.fullName,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.email ? { email: input.email } : {}),
      payerId: payer.id
    });
  }

  public async updateSitePerson(siteId: string, person: {
    readonly contactId?: string;
    readonly payerId?: string;
    readonly fullName: string;
    readonly phone?: string;
    readonly email?: string;
    readonly inn?: string;
    readonly kpp?: string;
  }): Promise<void> {
    const requisites = {
      ...(person.inn ? { inn: person.inn } : {}),
      ...(person.kpp ? { kpp: person.kpp } : {})
    };
    let payerId = person.payerId;
    if (payerId) {
      await this.updatePayer(payerId, { name: person.fullName, requisites });
      await this.linkPayerToSite(siteId, payerId);
    } else {
      const created = await this.createPayer({ name: person.fullName, requisites, siteId });
      payerId = created.id;
    }
    if (person.contactId) {
      await this.updateContact(siteId, person.contactId, {
        fullName: person.fullName,
        phone: person.phone || null,
        email: person.email || null,
        payerId
      });
      return;
    }
    await this.createContact(siteId, {
      fullName: person.fullName,
      ...(person.phone ? { phone: person.phone } : {}),
      ...(person.email ? { email: person.email } : {}),
      payerId
    });
  }

  public async setSitePersonActive(siteId: string, person: {
    readonly contactId?: string;
    readonly payerId?: string;
  }, isActive: boolean): Promise<void> {
    if (person.contactId) {
      if (isActive) await this.updateContact(siteId, person.contactId, { isActive: true });
      else await this.removeContact(siteId, person.contactId);
    }
    if (person.payerId) {
      if (isActive) await this.updatePayer(person.payerId, { isActive: true });
      else await this.removePayer(person.payerId);
    }
  }

  public async adoptOrphanPayer(siteId: string, payerId: string): Promise<void> {
    const payer = (await this.listPayers(true)).find((item) => item.id === payerId);
    if (!payer) throw new M2ApiError(404, "Плательщик не найден");
    await this.linkPayerToSite(siteId, payerId);
    await this.createContact(siteId, {
      fullName: payer.name,
      payerId
    });
  }

  public async createPayer(input: Readonly<Record<string, unknown>>): Promise<PayerOption> {
    const requisitesSource = asRow(input.requisites ?? input);
    const inn = optionalText(requisitesSource, "inn") ?? optionalText(input, "inn");
    const kpp = optionalText(requisitesSource, "kpp") ?? optionalText(input, "kpp");
    const { data, error } = await this.db().from("payers").insert({
      name: input.name,
      requisites: {
        ...(inn ? { inn } : {}),
        ...(kpp ? { kpp } : {})
      }
    }).select("id, name, is_active, requisites").single();
    throwIfError(error);
    const payer = mapPayerOption(asRow(data));
    const siteId = optionalText(input, "siteId");
    if (siteId) await this.linkPayerToSite(siteId, payer.id);
    return payer;
  }

  public async updatePayer(id: string, input: Readonly<Record<string, unknown>>): Promise<PayerOption> {
    const patch: Row = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    const requisitesSource = input.requisites !== undefined ? asRow(input.requisites) : input;
    if (input.requisites !== undefined || input.inn !== undefined || input.kpp !== undefined) {
      const inn = optionalText(requisitesSource, "inn") ?? optionalText(input, "inn");
      const kpp = optionalText(requisitesSource, "kpp") ?? optionalText(input, "kpp");
      patch.requisites = {
        ...(inn ? { inn } : {}),
        ...(kpp ? { kpp } : {})
      };
    }
    const { data, error } = await this.db().from("payers").update(patch).eq("id", id).select("id, name, is_active, requisites").single();
    throwIfError(error);
    return mapPayerOption(asRow(data));
  }

  public async removePayer(id: string): Promise<unknown> {
    return this.updatePayer(id, { isActive: false });
  }

  public async tasksPage(query: {
    readonly status?: string;
    readonly search?: string;
    readonly engineerId?: string;
    /** Задачи одного прибора (для паспорта). */
    readonly equipmentId?: string;
    /** Только незакрытые задачи (без «Закрыта» и «Отменена»). */
    readonly openOnly?: boolean;
    readonly siteId?: string;
    readonly workTypeCode?: string;
    readonly priority?: "urgent" | "planned";
    readonly periodFrom?: string;
    readonly periodTo?: string;
    readonly overdue?: boolean;
    readonly sort?: "deadline_asc" | "deadline_desc" | "updated_asc" | "updated_desc";
    /** Колонка доски: сначала карточки, расставленные вручную, затем остальные по сортировке. */
    readonly boardOrder?: boolean;
    readonly limit?: number;
    readonly offset?: number;
    /** Счётчики «новые» и «на проверке» (по умолчанию не запрашиваются: экраны их не показывают). */
    readonly withAttention?: boolean;
  } = {}): Promise<ApiPage<TaskApiRecord> & {
    readonly attention: { readonly new: number; readonly overdue: number; readonly underReview: number };
    /** Колонка отсортирована по местам, заданным вручную (запросили доску и в базе есть порядок карточек). */
    readonly boardOrdered: boolean;
  }> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const ascending = query.sort === "deadline_asc" || query.sort === "updated_asc";
    const sortColumn = query.sort?.startsWith("deadline") ? "deadline_to" : "updated_at";
    const applyTaskFilters = <T extends {
      eq: (column: string, value: string) => T;
      or: (filters: string) => T;
      gte: (column: string, value: string) => T;
      lte: (column: string, value: string) => T;
      lt: (column: string, value: string) => T;
      not: (column: string, operator: string, value: string) => T;
    }>(request: T): T => {
      let next = request;
      // Период: задачи, срок которых пересекается с выбранным периодом.
      if (query.periodFrom) next = next.gte("deadline_to", query.periodFrom.slice(0, 10));
      if (query.periodTo) next = next.lte("deadline_from", query.periodTo.slice(0, 10));
      if (query.overdue) {
        next = next.lt("deadline_to", new Date().toISOString().slice(0, 10)).not("status_code", "in", "(closed,cancelled)");
      }
      if (query.status) next = next.eq("status_code", query.status);
      if (query.engineerId) next = next.eq("engineer_id", query.engineerId);
      if (query.equipmentId) next = next.eq("equipment_id", query.equipmentId);
      if (query.openOnly) next = next.not("status_code", "in", "(closed,cancelled)");
      if (query.siteId) next = next.eq("site_id", query.siteId);
      if (query.workTypeCode) next = next.eq("work_type_code", query.workTypeCode);
      if (query.priority) next = next.eq("priority", query.priority);
      if (query.search?.trim()) next = next.or(`number.ilike.%${query.search.trim()}%,title.ilike.%${query.search.trim()}%`);
      return next;
    };
    const select = this.taskSelect();
    const withAttention = query.withAttention === true;
    // Доска: сначала карточки по месту, заданному вручную, остальные ниже по обычной сортировке.
    // Номер задачи в конце, чтобы при одинаковом сроке порядок не прыгал между страницами.
    const pageRequest = (fields: string, board: boolean) => {
      const request = this.db().from("tasks").select(board ? `${fields}, board_position` : fields, { count: "exact" });
      const ordered = board
        ? request.order("board_position", { ascending: true, nullsFirst: false }).order(sortColumn, { ascending }).order("id", { ascending: true })
        : request.order(sortColumn, { ascending });
      return applyTaskFilters(ordered.range(offset, offset + limit - 1));
    };
    let board = query.boardOrder === true && boardOrderAvailable;
    // Список и счётчики идут одновременно, а не друг за другом.
    const [firstPage, newCountResult, reviewCountResult] = await Promise.all([
      pageRequest(select, board),
      withAttention ? this.db().from("tasks").select("id", { count: "exact", head: true }).eq("status_code", "new") : Promise.resolve({ count: 0 }),
      withAttention ? this.db().from("tasks").select("id", { count: "exact", head: true }).eq("status_code", "under_review") : Promise.resolve({ count: 0 })
    ]);
    let primary = firstPage;
    if (board && isMissingBoardOrderSchema(primary.error)) {
      // В базе ещё нет порядка карточек: показываем доску как раньше, по сортировке.
      boardOrderAvailable = false;
      board = false;
      primary = await pageRequest(select, false);
    }
    let rows = primary.data;
    let error = primary.error;
    let count = primary.count;
    // Без полей инициатора повторяем, только если их нет в базе: таймаут или сбой сети
    // не должны отключать эти поля до перезагрузки страницы.
    if (error && select === TASK_SELECT && this.isMissingInitiatorContactSchema(error)) {
      this.markInitiatorContactUnavailable();
      const fallback = await pageRequest(TASK_SELECT_WITHOUT_INITIATOR_CONTACT, board);
      rows = fallback.data as typeof rows;
      error = fallback.error;
      count = fallback.count;
    } else if (!error && select === TASK_SELECT) {
      this.markInitiatorContactAvailable();
    }
    throwIfError(error);
    const items = (rows ?? []).map((item) => mapTask(asRow(item)));
    const newCount = newCountResult.count;
    const reviewCount = reviewCountResult.count;
    return {
      items,
      total: count ?? 0,
      limit,
      offset,
      attention: { new: newCount ?? 0, overdue: items.filter((item) => item.isOverdue).length, underReview: reviewCount ?? 0 },
      boardOrdered: board
    };
  }

  public async mailInbox(query: { readonly search?: string; readonly status?: string; readonly limit?: number; readonly offset?: number } = {}): Promise<MailInboxResponse> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    let request = this.db().from("mail_messages").select(MAIL_SELECT, { count: "exact" }).order("received_at", { ascending: false }).range(offset, offset + limit - 1);
    if (query.status) request = request.eq("status", query.status);
    const search = query.search?.trim().replace(/[,()%*\\]/gu, " ").trim();
    if (search) request = request.or(`sender.ilike.%${search}%,subject.ilike.%${search}%`);
    const { data, error, count } = await request;
    throwIfError(error);
    return {
      items: (data ?? []).map((item) => mailRecord(asRow(item))),
      total: count ?? 0,
      limit,
      offset
    };
  }

  public async updateMailInbox(id: string, input: { readonly status: "pending" | "parsed" | "ignored" | "converted"; readonly taskId?: string }): Promise<MailInboxRecord> {
    let request = this.db().from("mail_messages").update({
      status: input.status,
      task_id: input.taskId ?? null
    }).eq("id", id);
    // Задачу из письма создаёт один координатор: второй получит понятную ошибку, а не дубль.
    if (input.status === "converted") request = request.is("task_id", null).in("status", ["pending", "parsed", "failed"]);
    const { data, error } = await request.select(MAIL_SELECT).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(409, "По этому письму уже создана задача или оно отмечено как не требующее работы. Обновите список писем.");
    return mailRecord(asRow(data));
  }

  /** Прибор, найденный службой по S/N из письма, в виде для формы задачи. */
  public async mailEquipment(mail: MailInboxRecord): Promise<EquipmentApiRecord | undefined> {
    if (!mail.equipmentId) return undefined;
    return this.loadEquipment(mail.equipmentId);
  }

  /**
   * Письмо и вложения переходят в файлы задачи: копия в папку задачи, чтобы их
   * видел инженер (папка писем открыта только тем, кто разбирает почту).
   * Возвращает число файлов, которые не получилось перенести.
   */
  public async attachMailToTask(mail: MailInboxRecord, taskId: string): Promise<number> {
    const actor = await this.actorId();
    const items: MailAttachment[] = [
      ...(mail.rawStorageKey ? [{ storageKey: mail.rawStorageKey, fileName: "Письмо клиента.eml", contentType: "message/rfc822", byteSize: 0 }] : []),
      ...(mail.attachments ?? [])
    ];
    let failed = 0;
    for (const item of items) {
      const target = `tasks/${taskId}/${storageObjectName(item.fileName)}`;
      const { error: copyError } = await this.db().storage.from("medtech-files").copy(item.storageKey, target);
      if (copyError) { failed += 1; continue; }
      const { error } = await this.db().from("files").insert({
        kind: "mail_attachment",
        task_id: taskId,
        storage_key: target,
        original_name: item.fileName,
        content_type: item.contentType || "application/octet-stream",
        byte_size: item.byteSize > 0 ? item.byteSize : 1,
        uploaded_by: actor,
        is_financial: false
      });
      if (error) failed += 1;
    }
    return failed;
  }

  public async engineerTasks(limit = 20, offset = 0): Promise<EngineerTaskListResponse> {
    const userId = await this.actorId();
    const page = await this.tasksPage({ engineerId: userId, limit, offset });
    return {
      items: page.items.map((task): EngineerTaskListItem => ({
        id: task.id,
        number: task.number,
        title: task.title,
        status: task.status as EngineerTaskListItem["status"],
        priority: task.priority,
        isNew: task.status === "new" || task.status === "assigned",
        isOverdue: task.isOverdue === true,
        site: { name: task.customer?.siteName ?? "", address: task.customer?.address ?? "" },
        equipment: { id: task.equipmentId ?? "", serialNumber: task.equipmentLabel?.serialNumber ?? "", manufacturer: task.equipmentLabel?.manufacturer ?? "", model: task.equipmentLabel?.model ?? "" },
        dates: { call: task.callDate, periodFrom: task.periodFrom, periodTo: task.periodTo, visit: task.visitDate }
      })),
      total: page.total,
      limit,
      offset
    };
  }

  public async listTasks(status?: string): Promise<readonly TaskApiRecord[]> {
    const items: TaskApiRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.tasksPage({ ...(status ? { status } : {}), limit: 100, offset });
      items.push(...page.items);
      if (items.length >= page.total || page.items.length === 0) return items;
    }
  }

  public async createTask(input: Readonly<Record<string, unknown>>): Promise<TaskApiRecord> {
    const actor = await this.actorId();
    let siteId = input.siteId ?? null;
    let payerId = input.payerId ?? null;
    if (input.equipmentId && (siteId == null || payerId == null)) {
      const device = await this.loadEquipment(String(input.equipmentId));
      siteId = siteId ?? device.siteId ?? null;
      payerId = payerId ?? device.payerId ?? null;
    }
    if (!input.equipmentId || !siteId || !payerId) {
      throw new M2ApiError(400, "Укажите прибор с площадкой и плательщиком в паспорте.");
    }
    const callReason = typeof input.callReason === "string" ? input.callReason.trim() : "";
    const payload = {
      title: input.title,
      work_type_code: String(input.workTypeCode || "diagnostics"),
      priority: input.priority ?? "planned",
      is_maintenance_plan: input.isMaintenancePlan === true,
      maintenance_plan_id: input.maintenancePlanId ?? null,
      equipment_id: input.equipmentId,
      site_id: siteId,
      site_contact_id: input.siteContactId ?? null,
      initiator_contact_id: input.initiatorContactId ?? null,
      payer_id: payerId,
      engineer_id: input.engineerId ?? null,
      deadline_from: input.periodFrom ?? null,
      deadline_to: input.periodTo ?? null,
      call_date: input.callDate ?? new Date().toISOString().slice(0, 10),
      visit_date: input.visitDate ?? null,
      call_reason: callReason || null,
      created_by: actor,
      ...(input.payerOverrideReason ? {
        payer_override_reason: input.payerOverrideReason,
        payer_overridden_by: actor
      } : {})
    };
    let { data, error } = await this.db().from("tasks").insert(payload).select("id").single();
    if (error && this.isMissingInitiatorContactSchema(error) && input.initiatorContactId) {
      throw new M2ApiError(400, "Поле «Инициатор» ещё не доступно в базе. Примените миграцию 0007.");
    }
    if (error && (this.isMissingInitiatorContactSchema(error) || /initiator_contact/iu.test(error.message ?? ""))) {
      this.markInitiatorContactUnavailable();
      const { initiator_contact_id: _, ...withoutInitiator } = payload;
      void _;
      ({ data, error } = await this.db().from("tasks").insert(withoutInitiator).select("id").single());
    }
    throwIfError(error, "Не получилось создать задачу");
    return this.loadTask(text(asRow(data), "id"));
  }

  public async updateTaskOverview(id: string, input: {
    readonly title: string;
    readonly workTypeCode: string;
    readonly priority: "urgent" | "planned";
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly callDate: string;
    readonly visitDate?: string;
  }): Promise<TaskApiRecord> {
    const { error } = await this.db().from("tasks").update({
      title: input.title,
      work_type_code: input.workTypeCode,
      priority: input.priority,
      deadline_from: input.periodFrom,
      deadline_to: input.periodTo,
      call_date: input.callDate,
      visit_date: input.visitDate ?? null
    }).eq("id", id);
    throwIfError(error);
    return this.loadTask(id);
  }

  public async updateTaskResult(id: string, input: {
    readonly callReason: string;
    readonly workDescription: string;
    readonly recommendations: string;
    readonly userRemarks: string;
    readonly workCompleted: boolean;
    readonly apparatusApproved: boolean;
    readonly customerHasNoClaims: boolean;
    readonly continuedInPrimary: boolean;
    readonly actFileId?: string;
    /** Поля ниже пишутся, только если переданы (undefined не трогает значение, null очищает). */
    readonly reasonCode?: string | null;
    readonly workModifier?: "G" | "N" | null;
    readonly meterReading?: number | null;
    readonly hours?: number | null;
  }): Promise<TaskCardResponse> {
    const { error } = await this.db().from("tasks").update({
      ...(input.reasonCode !== undefined ? { reason_code: input.reasonCode } : {}),
      ...(input.workModifier !== undefined ? { work_modifier: input.workModifier } : {}),
      ...(input.meterReading !== undefined ? { meter_reading: input.meterReading } : {}),
      ...(input.hours !== undefined ? { hours: input.hours } : {}),
      call_reason: input.callReason || null,
      work_description: input.workDescription || null,
      recommendations: input.recommendations || null,
      user_remarks: input.userRemarks || null,
      work_completed: input.workCompleted,
      apparatus_approved: input.apparatusApproved,
      customer_has_no_claims: input.customerHasNoClaims,
      continued_in_primary: input.continuedInPrimary
    }).eq("id", id);
    throwIfError(error);
    if (input.actFileId) {
      const actor = await this.actorId();
      const { data: existing, error: existingError } = await this.db()
        .from("task_closures")
        .select("task_id, verified_by, verified_at")
        .eq("task_id", id)
        .maybeSingle();
      throwIfError(existingError);
      if (existing && optionalText(asRow(existing), "verified_by")) {
        const { error: actError } = await this.db().from("task_closures").update({
          act_file_id: input.actFileId
        }).eq("task_id", id);
        throwIfError(actError);
      } else {
        const { error: closureError } = await this.db().from("task_closures").upsert({
          task_id: id,
          act_file_id: input.actFileId,
          submitted_by: actor,
          submitted_at: new Date().toISOString(),
          verified_by: null,
          verified_at: null,
          verification_comment: null
        });
        throwIfError(closureError);
      }
    }
    return this.taskCard(id);
  }

  public async uploadTaskFiles(
    id: string,
    files: readonly File[],
    kind: "act" | "photo" | "video" | "document" = "document"
  ): Promise<readonly EquipmentFileResponse[]> {
    const actor = await this.actorId();
    const uploadedIds: string[] = [];
    for (const file of files) {
      const key = `tasks/${id}/${storageObjectName(file.name)}`;
      const { error: storageError } = await this.db().storage.from("medtech-files").upload(key, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false
      });
      throwIfError(storageError, "Не удалось загрузить файл");
      const { data, error } = await this.db().from("files").insert({
        kind,
        task_id: id,
        storage_key: key,
        original_name: file.name,
        content_type: file.type || "application/octet-stream",
        byte_size: file.size,
        uploaded_by: actor,
        is_financial: false
      }).select("id").single();
      throwIfError(error);
      uploadedIds.push(text(asRow(data), "id"));
    }
    if (kind === "act" && uploadedIds[0]) {
      const actorId = await this.actorId();
      const { data: existing, error: existingError } = await this.db()
        .from("task_closures")
        .select("task_id, verified_by")
        .eq("task_id", id)
        .maybeSingle();
      throwIfError(existingError);
      if (existing && optionalText(asRow(existing), "verified_by")) {
        const { error: actError } = await this.db().from("task_closures").update({
          act_file_id: uploadedIds[0]
        }).eq("task_id", id);
        throwIfError(actError);
      } else {
        const { error: closureError } = await this.db().from("task_closures").upsert({
          task_id: id,
          act_file_id: uploadedIds[0],
          submitted_by: actorId,
          submitted_at: new Date().toISOString(),
          verified_by: null,
          verified_at: null,
          verification_comment: null
        });
        throwIfError(closureError);
      }
    }
    const card = await this.taskCard(id);
    return card.files;
  }

  public async maintenancePlans(
    year: number,
    view: "equipment" | "engineer" | "organization",
    filters: { readonly equipmentId?: string; readonly engineerId?: string; readonly organizationId?: string } = {}
  ): Promise<MaintenancePlanListResponse> {
    let request = this.db()
      .from("maintenance_plans")
      .select("id, equipment_id, plan_year, period_no, period_from, period_to, status, assigned_engineer_id, comment, equipment:equipment(serial_number, manufacturer:manufacturers(name), model:equipment_models(name), site:sites!current_site_id(id, name, organization_id, organization:organizations(name))), engineer:users!assigned_engineer_id(full_name)")
      .eq("plan_year", year)
      .order("period_from");
    if (filters.equipmentId) request = request.eq("equipment_id", filters.equipmentId);
    if (filters.engineerId) request = request.eq("assigned_engineer_id", filters.engineerId);
    const { data, error } = await request;
    throwIfError(error);
    const items: MaintenancePlanPeriodResponse[] = (data ?? []).map((item) => {
      const row = asRow(item);
      const equipment = related(row, "equipment");
      const site = related(equipment, "site");
      const periodFrom = text(row, "period_from");
      const periodTo = text(row, "period_to");
      return {
        id: text(row, "id"),
        equipmentId: text(row, "equipment_id"),
        year: numberValue(row.plan_year) ?? year,
        periodNo: numberValue(row.period_no) ?? 1,
        periodFrom,
        periodTo,
        status: text(row, "status") as MaintenancePlanPeriodResponse["status"],
        assignedEngineerId: optionalText(row, "assigned_engineer_id"),
        assignedEngineerName: optionalText(related(row, "engineer"), "full_name"),
        comment: optionalText(row, "comment"),
        equipment: {
          serialNumber: text(equipment, "serial_number"),
          manufacturer: text(related(equipment, "manufacturer"), "name"),
          model: text(related(equipment, "model"), "name")
        },
        organizationId: optionalText(site, "organization_id"),
        organization: optionalText(related(site, "organization"), "name"),
        siteId: optionalText(site, "id"),
        site: optionalText(site, "name"),
        timeline: maintenancePeriodOnYearTimeline({ periodFrom, periodTo }, year)
      };
    }).filter((item) => !filters.organizationId || item.organizationId === filters.organizationId);
    const groupKey = (item: MaintenancePlanPeriodResponse): { readonly key: string; readonly label: string } => {
      if (view === "engineer") return { key: item.assignedEngineerId ?? "none", label: item.assignedEngineerName ?? "Без инженера" };
      if (view === "organization") return { key: item.organizationId ?? "none", label: item.organization ?? "Без организации" };
      return { key: item.equipmentId, label: item.equipment.serialNumber };
    };
    const groupsMap = new Map<string, { readonly key: string; readonly label: string; items: MaintenancePlanPeriodResponse[] }>();
    for (const item of items) {
      const group = groupKey(item);
      const current = groupsMap.get(group.key) ?? { key: group.key, label: group.label, items: [] };
      current.items.push(item);
      groupsMap.set(group.key, current);
    }
    return { year, view, items, groups: [...groupsMap.values()] };
  }

  public async replaceMaintenancePlan(input: ReplaceAnnualMaintenancePlanRequest): Promise<{
    readonly year: number;
    readonly items: MaintenancePlanListResponse["items"];
  }> {
    assertAnnualMaintenancePlan(input);
    const actor = await this.actorId();
    const { error: deleteError } = await this.db().from("maintenance_plans").delete().eq("equipment_id", input.equipmentId).eq("plan_year", input.year);
    throwIfError(deleteError);
    const rows = input.periods.map((period, index) => ({
      equipment_id: input.equipmentId,
      plan_year: input.year,
      period_no: index + 1,
      period_from: period.periodFrom,
      period_to: period.periodTo,
      work_type_code: "maintenance",
      assigned_engineer_id: period.assignedEngineerId ?? null,
      comment: period.comment ?? null,
      created_by: actor
    }));
    const { error } = await this.db().from("maintenance_plans").insert(rows);
    throwIfError(error);
    const list = await this.maintenancePlans(input.year, "equipment", { equipmentId: input.equipmentId });
    return { year: input.year, items: list.items };
  }

  public async generateMaintenanceTasks(year: number, planIds?: readonly string[]): Promise<GenerateMaintenanceTasksResponse> {
    const actor = await this.actorId();
    let request = this.db().from("maintenance_plans").select("id, equipment_id, period_from, period_to, assigned_engineer_id, status").eq("plan_year", year).eq("status", "planned");
    if (planIds?.length) request = request.in("id", [...planIds]);
    const { data, error } = await request;
    throwIfError(error);
    const created: Array<{ readonly planId: string; readonly taskId: string }> = [];
    const existing: Array<{ readonly planId: string; readonly taskId: string }> = [];
    const failures: Array<{ readonly planId: string; readonly code: "invalid_status" | "missing_relation" | "not_found"; readonly error: string }> = [];
    for (const item of data ?? []) {
      const row = asRow(item);
      const planId = text(row, "id");
      const { data: existingTask, error: existingError } = await this.db().from("tasks").select("id").eq("maintenance_plan_id", planId).maybeSingle();
      throwIfError(existingError);
      if (existingTask) {
        existing.push({ planId, taskId: text(asRow(existingTask), "id") });
        continue;
      }
      try {
        const task = await this.createTask({
          title: `ТО ${year}`,
          workTypeCode: "maintenance",
          isMaintenancePlan: true,
          maintenancePlanId: planId,
          equipmentId: text(row, "equipment_id"),
          engineerId: optionalText(row, "assigned_engineer_id"),
          periodFrom: text(row, "period_from"),
          periodTo: text(row, "period_to")
        });
        const { error: updateError } = await this.db().from("maintenance_plans").update({
          status: "generated",
          generated_at: new Date().toISOString(),
          generated_by: actor
        }).eq("id", planId);
        throwIfError(updateError);
        created.push({ planId, taskId: task.id });
      } catch (caught) {
        failures.push({ planId, code: "invalid_status", error: caught instanceof Error ? caught.message : "Не удалось создать задачу" });
      }
    }
    return { requestedCount: (data ?? []).length, created, existing, failures };
  }

  public async taskCard(id: string): Promise<TaskCardResponse> {
    // Шаг 1: всё, что зависит только от id задачи, одновременно.
    const loadParts = async (): Promise<{ data: unknown[] | null; error: { message?: string } | null }> => {
      const withSale = await this.db()
        .from("task_parts")
        .select("id, article_number_snapshot, name_snapshot, quantity, part_condition, for_sale")
        .eq("task_id", id)
        .order("position");
      if (withSale.error && /for_sale/iu.test(withSale.error.message ?? "")) {
        return this.db()
          .from("task_parts")
          .select("id, article_number_snapshot, name_snapshot, quantity, part_condition")
          .eq("task_id", id)
          .order("position");
      }
      return withSale;
    };
    // Вид работ, причина, этап и прибор приходят вместе с задачей, имена авторов вместе
    // с историей и закрытием: карточка открывается одной волной запросов. Ссылки на фото
    // подгружает галерея после показа карточки.
    const journalSelect = "id, from_status, to_status, comment, changed_at, changed_by";
    const closureSelect = "task_id, act_file_id, submitted_by, submitted_at, verified_by, verified_at, verification_comment";
    const [cardRow, session, parts, files, journalWithNames, closureWithName] = await Promise.all([
      this.loadTaskCardRow(id).catch((error: unknown) => {
        if (error instanceof M2ApiError && error.status === 404) throw error;
        return undefined;
      }),
      this.cachedSession(),
      loadParts(),
      this.db().from("files").select(FILE_SELECT).eq("task_id", id).order("created_at"),
      this.db().from("task_status_history").select(`${journalSelect}, changer:users!changed_by(full_name)`).eq("task_id", id).order("changed_at", { ascending: false }),
      this.db().from("task_closures").select(`${closureSelect}, submitter:users!submitted_by(full_name)`).eq("task_id", id).maybeSingle()
    ]);
    // Если имена авторов не встроились (другая схема базы), читаем как раньше, без них.
    const journal = journalWithNames.error
      ? await this.db().from("task_status_history").select(journalSelect).eq("task_id", id).order("changed_at", { ascending: false })
      : journalWithNames;
    const closure = closureWithName.error
      ? await this.db().from("task_closures").select(closureSelect).eq("task_id", id).maybeSingle()
      : closureWithName;
    throwIfError(parts.error);
    throwIfError(files.error);
    throwIfError(journal.error);
    throwIfError(closure.error);
    const canSeeFinance = session.permissions?.includes("finance.read") === true;
    const closureRow = closure.data ? asRow(closure.data) : undefined;
    const submitterId = closureRow ? optionalText(closureRow, "submitted_by") : undefined;
    const task = cardRow ? mapTask(cardRow) : await this.loadTask(id);
    const actorNameById = new Map<string, string>();
    for (const item of journal.data ?? []) {
      const row = asRow(item);
      const actor = optionalText(row, "changed_by");
      const name = optionalText(related(row, "changer"), "full_name");
      if (actor && name) actorNameById.set(actor, name);
    }
    if (submitterId && closureRow && optionalText(related(closureRow, "submitter"), "full_name")) {
      actorNameById.set(submitterId, optionalText(related(closureRow, "submitter"), "full_name") ?? "");
    }
    if (task.engineerId && task.engineerName) actorNameById.set(task.engineerId, task.engineerName);
    const missingActors = [...new Set([
      ...(journal.data ?? []).map((item) => optionalText(asRow(item), "changed_by")),
      submitterId,
      task.engineerId
    ].filter((value): value is string => Boolean(value) && !actorNameById.has(value as string)))];
    const mappedFiles = this.mapFilesLazy(files.data, canSeeFinance);
    let workType: { readonly data: unknown };
    let reason: { readonly data: unknown };
    let statusRow: { readonly data: unknown };
    let equipment: EquipmentApiRecord | undefined;
    if (cardRow) {
      const workTypeRow = related(cardRow, "work_type");
      const reasonRow = related(cardRow, "reason");
      const equipmentRow = related(cardRow, "equipment_full");
      workType = { data: optionalText(workTypeRow, "code") ? workTypeRow : null };
      reason = { data: optionalText(reasonRow, "code") ? reasonRow : null };
      statusRow = { data: optionalText(related(cardRow, "status"), "code") ? related(cardRow, "status") : null };
      equipment = optionalText(equipmentRow, "id") ? mapEquipment(equipmentRow) : undefined;
    } else {
      // Запасной путь, как раньше: справочные данные вторым шагом.
      const [workTypeResult, reasonResult, statusResult, equipmentResult] = await Promise.all([
        task.workTypeCode ? this.db().from("work_types").select("code, name").eq("code", task.workTypeCode).maybeSingle() : Promise.resolve({ data: null, error: null }),
        task.reasonCode ? this.db().from("task_reasons").select("code, name").eq("code", task.reasonCode).maybeSingle() : Promise.resolve({ data: null, error: null }),
        this.db().from("task_statuses").select("code, name").eq("code", task.status).maybeSingle(),
        task.equipmentId ? this.loadEquipment(task.equipmentId) : Promise.resolve(undefined)
      ]);
      throwIfError(workTypeResult.error);
      throwIfError(reasonResult.error);
      throwIfError(statusResult.error);
      workType = workTypeResult;
      reason = reasonResult;
      statusRow = statusResult;
      equipment = equipmentResult;
    }
    // Имена, которые не пришли вместе с данными (запасной путь), одним запросом.
    if (missingActors.length && (!cardRow || journalWithNames.error || closureWithName.error)) {
      const people = await this.db().from("users").select("id, full_name").in("id", missingActors);
      throwIfError(people.error);
      for (const item of people.data ?? []) actorNameById.set(text(asRow(item), "id"), text(asRow(item), "full_name"));
    }
    const engineer = { data: task.engineerId && actorNameById.has(task.engineerId) ? { id: task.engineerId, full_name: actorNameById.get(task.engineerId) } : null };
    const submitter = { data: submitterId && actorNameById.has(submitterId) ? { full_name: actorNameById.get(submitterId) } : null };
    const canWrite = session.permissions?.includes("tasks.write") === true || session.permissions?.includes("tasks.write_own") === true;
    const terminal = ["closed", "cancelled"].includes(task.status);
    return {
      task,
      equipment,
      engineer: engineer.data ? { id: text(asRow(engineer.data), "id"), fullName: text(asRow(engineer.data), "full_name") } : undefined,
      workType: workType.data ? { code: text(asRow(workType.data), "code"), name: text(asRow(workType.data), "name") } : undefined,
      reason: reason.data ? { code: text(asRow(reason.data), "code"), name: text(asRow(reason.data), "name") } : undefined,
      status: { code: task.status, name: optionalText(asRow(statusRow.data), "name") ?? task.status },
      closure: closureRow ? {
        taskId: text(closureRow, "task_id"),
        actFileId: text(closureRow, "act_file_id"),
        submittedBy: optionalText(closureRow, "submitted_by"),
        submittedByName: optionalText(asRow(submitter.data), "full_name") || optionalText(related(closureRow, "submitter"), "full_name"),
        submittedAt: iso(closureRow.submitted_at),
        verifiedBy: optionalText(closureRow, "verified_by"),
        verifiedAt: optionalText(closureRow, "verified_at"),
        verificationComment: optionalText(closureRow, "verification_comment"),
        workCompleted: task.workCompleted,
        apparatusApproved: task.apparatusApproved,
        customerHasNoClaims: task.customerHasNoClaims,
        callReason: task.callReason,
        workDescription: task.workDescription,
        recommendations: task.recommendations,
        userRemarks: task.userRemarks,
        continuedInPrimary: task.continuedInPrimary,
        continuationTaskId: task.continuationTaskId,
        continuationTaskNumber: task.continuationTaskNumber,
        meterReading: task.meterReading,
        workModifier: task.workModifier,
        hours: task.hours
      } : undefined,
      parts: (parts.data ?? []).map((item) => {
        const row = asRow(item);
        return {
          id: text(row, "id"),
          articleNumber: text(row, "article_number_snapshot"),
          name: text(row, "name_snapshot"),
          quantity: numberValue(row.quantity) ?? 0,
          condition: text(row, "part_condition") as TaskPartPosition["condition"],
          ...(row.for_sale === true ? { forSale: true } : {})
        };
      }),
      canEditOverview: !terminal && canWrite,
      canEditParts: !terminal && canWrite,
      canUploadFiles: !terminal && session.permissions?.includes("files.write") === true,
      canReassign: Boolean(task.engineerId) && ["assigned", "in_progress"].includes(task.status) && session.permissions?.includes("tasks.assign") === true && session.permissions?.includes("tasks.write") === true,
      canSubmitResult: task.status === "in_progress" && task.engineerId === session.id && session.permissions?.includes("tasks.close") === true,
      canSetWorkModifier: !terminal && session.permissions?.includes("tasks.write") === true,
      canSeeFinance,
      isTaskEngineer: Boolean(task.engineerId) && task.engineerId === session.id,
      files: mappedFiles,
      journal: (journal.data ?? []).map((item) => {
        const row = asRow(item);
        return {
          id: text(row, "id"),
          action: `${optionalText(row, "from_status") ?? ""} → ${text(row, "to_status")}`,
          occurredAt: iso(row.changed_at),
          actorName: optionalText(asRow(item), "changed_by")
            ? actorNameById.get(text(asRow(item), "changed_by"))
            : undefined,
          fromStatus: optionalText(row, "from_status"),
          toStatus: optionalText(row, "to_status"),
          comment: optionalText(row, "comment")
        };
      }),
      availableActions: availableTaskActions(session.role, task.status, {
        hasClosure: Boolean(closureRow),
        closureVerified: Boolean(optionalText(closureRow ?? {}, "verified_by") && optionalText(closureRow ?? {}, "verified_at"))
      })
    };
  }

  public async replaceTaskParts(id: string, items: readonly Omit<TaskPartPosition, "id">[]): Promise<TaskPartsResponse> {
    const { error: deleteError } = await this.db().from("task_parts").delete().eq("task_id", id);
    throwIfError(deleteError);
    if (items.length) {
      const articles = items.map((item) => item.articleNumber);
      const { data: parts, error: partsError } = await this.db().from("parts").select("id, article_number").in("article_number", articles);
      throwIfError(partsError);
      const partIdByArticle = new Map((parts ?? []).map((item) => [text(asRow(item), "article_number"), text(asRow(item), "id")]));
      const rowsWithSale = items.map((item, index) => {
        const partId = partIdByArticle.get(item.articleNumber);
        if (!partId) throw new M2ApiError(400, `Номенклатура ${item.articleNumber} не найдена`);
        return {
          task_id: id,
          part_id: partId,
          part_condition: item.condition,
          article_number_snapshot: item.articleNumber,
          name_snapshot: item.name,
          quantity: item.quantity,
          for_sale: item.forSale === true,
          position: index
        };
      });
      let { error } = await this.db().from("task_parts").insert(rowsWithSale);
      if (error && /for_sale/iu.test(error.message ?? "")) {
        ({ error } = await this.db().from("task_parts").insert(rowsWithSale.map(({ for_sale: _, ...row }) => {
          void _;
          return row;
        })));
      }
      throwIfError(error);
    }
    const card = await this.taskCard(id);
    return { items: card.parts };
  }

  public async listTaskEngineers(): Promise<readonly { readonly id: string; readonly fullName: string }[]> {
    const { data, error } = await this.db().from("users").select("id, full_name").eq("role", "engineer").eq("is_active", true).order("full_name");
    throwIfError(error);
    return (data ?? []).map((item) => ({ id: text(asRow(item), "id"), fullName: text(asRow(item), "full_name") }));
  }

  public async engineers(): Promise<readonly EngineerOverview[]> {
    // Инженеры и их открытые задачи одновременно. Загрузка: только незакрытые задачи,
    // все, а не первые 1000 (столько сервер отдаёт за один запрос).
    const [{ data, error }, tasks] = await Promise.all([
      this.db().from("users").select("id, full_name, is_active, engineer_competencies(model_line, manufacturer:manufacturers(name))").eq("role", "engineer").order("full_name"),
      allPages((start, end, withCount) => this.db().from("tasks")
        .select("id, engineer_id, status_code, deadline_to", withCount ? { count: "exact" } : undefined)
        .not("engineer_id", "is", null).not("status_code", "in", "(closed,cancelled)")
        .order("id", { ascending: true })
        .range(start, end), "Не получилось загрузить задачи инженеров")
    ]);
    throwIfError(error);
    const engineers = data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return engineers.map((item) => {
      const row = asRow(item);
      const id = text(row, "id");
      const assigned = (tasks ?? []).filter((task) => text(asRow(task), "engineer_id") === id);
      const competencies = Array.isArray(row.engineer_competencies) ? row.engineer_competencies : [];
      return {
        id,
        fullName: text(row, "full_name"),
        isActive: row.is_active !== false,
        competencies: competencies.map((competency) => ({
          manufacturer: optionalText(related(asRow(competency), "manufacturer"), "name"),
          modelLine: optionalText(asRow(competency), "model_line")
        })),
        assignedTaskCount: assigned.length,
        inProgressTaskCount: assigned.filter((task) => text(asRow(task), "status_code") === "in_progress").length,
        overdueTaskCount: assigned.filter((task) => {
          const deadline = optionalText(asRow(task), "deadline_to");
          const status = text(asRow(task), "status_code");
          return Boolean(deadline && deadline < today && !["closed", "cancelled"].includes(status));
        }).length
      };
    });
  }

  public async updateEngineer(id: string, input: Readonly<Record<string, unknown>>): Promise<EngineerOverview> {
    const patch: Row = {};
    if (input.fullName !== undefined) patch.full_name = input.fullName;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (Object.keys(patch).length) {
      const { error } = await this.db().from("users").update(patch).eq("id", id);
      throwIfError(error);
    }
    const list = await this.engineers();
    const engineer = list.find((item) => item.id === id);
    if (!engineer) throw new M2ApiError(404, "Инженер не найден");
    return engineer;
  }

  public async inventoryParts(includeInactive = true): Promise<readonly InventoryPartRecord[]> {
    return (await this.inventoryPartPage({ limit: 500, ...(includeInactive ? {} : { state: "active" }) })).items;
  }

  public async inventoryPartPage(query: { readonly search?: string; readonly state?: string; readonly sort?: string; readonly limit?: number; readonly offset?: number } = {}): Promise<InventoryPartPage> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    let request = this.db().from("parts").select("id, article_number, name, minimum_stock, notes, is_active", { count: "exact" }).order("name").range(offset, offset + limit - 1);
    if (query.search?.trim()) request = request.or(`article_number.ilike.%${query.search.trim()}%,name.ilike.%${query.search.trim()}%`);
    if (query.state === "active") request = request.eq("is_active", true);
    const { data, error, count } = await request;
    throwIfError(error);
    const ids = (data ?? []).map((item) => text(asRow(item), "id"));
    const { data: balances, error: balanceError } = ids.length
      ? await this.db().from("stock_balances").select("part_id, on_hand_quantity, reserved_quantity, available_quantity").in("part_id", ids)
      : { data: [], error: null };
    throwIfError(balanceError);
    const withEngineersByPart = await this.issuedQuantityByPart(ids);
    const balanceByPart = new Map<string, { onHandQuantity: number; reservedQuantity: number; availableQuantity: number }>();
    for (const item of balances ?? []) {
      const balance = asRow(item);
      const partId = text(balance, "part_id");
      const current = balanceByPart.get(partId) ?? { onHandQuantity: 0, reservedQuantity: 0, availableQuantity: 0 };
      balanceByPart.set(partId, {
        onHandQuantity: current.onHandQuantity + (numberValue(balance.on_hand_quantity) ?? 0),
        reservedQuantity: current.reservedQuantity + (numberValue(balance.reserved_quantity) ?? 0),
        availableQuantity: current.availableQuantity + (numberValue(balance.available_quantity) ?? 0)
      });
    }
    const items = (data ?? []).map((item) => {
      const row = asRow(item);
      const balance = balanceByPart.get(text(row, "id")) ?? { onHandQuantity: 0, reservedQuantity: 0, availableQuantity: 0 };
      const withEngineersQuantity = withEngineersByPart.get(text(row, "id")) ?? 0;
      const minimumStock = numberValue(row.minimum_stock) ?? 0;
      return {
        id: text(row, "id"),
        articleNumber: text(row, "article_number"),
        name: text(row, "name"),
        minimumStock,
        notes: optionalText(row, "notes"),
        isActive: row.is_active !== false,
        onHandQuantity: balance.onHandQuantity,
        reservedQuantity: balance.reservedQuantity,
        availableQuantity: balance.availableQuantity,
        withEngineersQuantity,
        belowMinimum: balance.availableQuantity < minimumStock
      };
    });
    return {
      items,
      total: count ?? 0,
      limit,
      offset,
      hasMore: offset + items.length < (count ?? 0),
      nextOffset: offset + items.length < (count ?? 0) ? offset + items.length : undefined,
      summary: {
        active: items.filter((item) => item.isActive).length,
        belowMinimum: items.filter((item) => item.belowMinimum).length,
        withEngineers: items.filter((item) => item.withEngineersQuantity > 0).length
      }
    };
  }

  public async createInventoryPart(input: Readonly<Record<string, unknown>>): Promise<InventoryPartRecord> {
    const { data, error } = await this.db().from("parts").insert({
      article_number: input.articleNumber,
      name: input.name,
      minimum_stock: input.minimumStock ?? 0,
      notes: input.notes ?? null
    }).select("id").single();
    throwIfError(error);
    const created = await this.loadInventoryPart(text(asRow(data), "id"));
    const initialQuantity = numberValue(input.initialQuantity);
    if (initialQuantity && initialQuantity > 0) {
      return this.receiveInventoryPart({
        partId: created.id,
        quantity: initialQuantity,
        condition: "N",
        comment: "Начальный остаток при создании позиции"
      });
    }
    return created;
  }

  public async updateInventoryPart(id: string, input: Readonly<Record<string, unknown>>): Promise<InventoryPartRecord> {
    const patch: Row = {};
    if (input.articleNumber !== undefined) patch.article_number = input.articleNumber;
    if (input.name !== undefined) patch.name = input.name;
    if (input.minimumStock !== undefined) patch.minimum_stock = input.minimumStock;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    const { error } = await this.db().from("parts").update(patch).eq("id", id);
    throwIfError(error);
    return this.loadInventoryPart(id);
  }

  public async receiveInventoryPart(input: {
    readonly partId: string;
    readonly quantity: number;
    readonly condition?: "G" | "N" | "B";
    readonly comment?: string;
    readonly sourceDocument?: string;
  }): Promise<InventoryPartRecord> {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new M2ApiError(400, "Укажите количество больше нуля");
    }
    const condition = input.condition ?? "N";
    const part = await this.loadInventoryPart(input.partId);
    if (!part.isActive) throw new M2ApiError(400, "Нельзя пополнить отключённую запчасть");
    const actor = await this.actorId();
    const { data: existingLots, error: lotFindError } = await this.db()
      .from("stock_lots")
      .select("id")
      .eq("part_id", input.partId)
      .eq("part_condition", condition)
      .eq("lot_code", "default")
      .limit(1);
    throwIfError(lotFindError);
    let lotId = existingLots?.[0] ? text(asRow(existingLots[0]), "id") : "";
    if (!lotId) {
      const { data: createdLot, error: lotCreateError } = await this.db().from("stock_lots").insert({
        part_id: input.partId,
        part_condition: condition,
        lot_code: "default",
        ...(input.sourceDocument ? { source_document: input.sourceDocument } : {})
      }).select("id").single();
      throwIfError(lotCreateError, "Не получилось подготовить партию на складе");
      lotId = text(asRow(createdLot), "id");
    }
    const { error: movementError } = await this.db().from("stock_movements").insert({
      idempotency_key: `receipt:${input.partId}:${condition}:${crypto.randomUUID()}`,
      movement_type: "receipt",
      lot_id: lotId,
      part_id: input.partId,
      part_condition: condition,
      quantity,
      on_hand_delta: quantity,
      performed_by: actor,
      comment: input.comment?.trim() || null
    });
    throwIfError(movementError, "Не получилось оприходовать запчасть");
    return this.loadInventoryPart(input.partId);
  }

  private async loadInventoryPart(id: string): Promise<InventoryPartRecord> {
    const { data, error } = await this.db().from("parts").select("id, article_number, name, minimum_stock, notes, is_active").eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Номенклатура не найдена");
    const row = asRow(data);
    const { data: balances, error: balanceError } = await this.db()
      .from("stock_balances")
      .select("on_hand_quantity, reserved_quantity, available_quantity")
      .eq("part_id", id);
    throwIfError(balanceError);
    let onHandQuantity = 0;
    let reservedQuantity = 0;
    let availableQuantity = 0;
    for (const item of balances ?? []) {
      const balance = asRow(item);
      onHandQuantity += numberValue(balance.on_hand_quantity) ?? 0;
      reservedQuantity += numberValue(balance.reserved_quantity) ?? 0;
      availableQuantity += numberValue(balance.available_quantity) ?? 0;
    }
    const minimumStock = numberValue(row.minimum_stock) ?? 0;
    const withEngineersQuantity = (await this.issuedQuantityByPart([id])).get(id) ?? 0;
    return {
      id: text(row, "id"),
      articleNumber: text(row, "article_number"),
      name: text(row, "name"),
      minimumStock,
      notes: optionalText(row, "notes"),
      isActive: row.is_active !== false,
      onHandQuantity,
      reservedQuantity,
      availableQuantity,
      withEngineersQuantity,
      belowMinimum: availableQuantity < minimumStock
    };
  }

  /** Сколько штук каждой запчасти сейчас выдано инженерам и ещё не установлено и не возвращено. */
  private async issuedQuantityByPart(partIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    const result = new Map<string, number>();
    if (partIds.length === 0) return result;
    const { data, error } = await this.db().from("stock_reservations").select("part_id, quantity").eq("status", "issued").in("part_id", [...partIds]);
    throwIfError(error);
    for (const item of data ?? []) {
      const row = asRow(item);
      const partId = text(row, "part_id");
      result.set(partId, (result.get(partId) ?? 0) + (numberValue(row.quantity) ?? 0));
    }
    return result;
  }

  /**
   * Резервы для окна склада. active: ждут сборки, выдачи или висят на инженере, по времени
   * заявки (строка не переезжает после действия, под курсором не окажется чужая кнопка).
   * closed: последние 100 закрытых.
   */
  public async stockReservations(state: "active" | "closed" = "active"): Promise<readonly StockReservationRecord[]> {
    const select = "id, number, status, part_id, part_condition, quantity, task_id, created_at, updated_at, "
      + "part:parts(article_number, name), task:tasks(number, title, status_code, engineer:users!engineer_id(full_name)), issued:users!issued_to(full_name)";
    let request = this.db().from("stock_reservations").select(select);
    request = state === "active"
      ? request.in("status", [...ACTIVE_RESERVATION_STATUSES]).order("created_at").order("number").limit(500)
      : request.in("status", [...CLOSED_RESERVATION_STATUSES]).order("updated_at", { ascending: false }).limit(100);
    const { data, error } = await request;
    throwIfError(error, "Не получилось загрузить резервы");
    return (data ?? []).map((item) => stockReservationRecord(asRow(item)));
  }

  /** Склад собрал запчасть, её можно выдавать инженеру. */
  public async markStockReservationReady(id: string): Promise<void> {
    await this.changeStockReservationStatus(id, "warehouse_notified", ["created"], "Не получилось отметить, что запчасть собрана");
  }

  /** Снять резерв, пока запчасть не выдана: она снова доступна на складе. */
  public async cancelStockReservation(id: string): Promise<void> {
    await this.changeStockReservationStatus(id, "cancelled", ["created", "warehouse_notified"], "Не получилось снять резерв");
  }

  /** Выдать запчасть инженеру задачи: статус и списание со склада одной операцией (миграция 0022). */
  public async issueStockReservation(id: string): Promise<void> {
    await this.stockReservationRpc("issue_stock_reservation", id, "Не получилось выдать запчасть");
  }

  /** Инженер вернул запчасть: она снова на складе (миграция 0022). */
  public async returnStockReservation(id: string): Promise<void> {
    await this.stockReservationRpc("return_stock_reservation", id, "Не получилось принять запчасть на склад");
  }

  private async changeStockReservationStatus(id: string, status: StockReservationStatus, from: readonly StockReservationStatus[], fallback: string): Promise<void> {
    const { data, error } = await this.db().from("stock_reservations").update({ status }).eq("id", id).in("status", [...from]).select("id");
    throwIfError(error, fallback);
    if (!data?.length) throw new M2ApiError(409, "Резерв уже в другом состоянии. Обновите список резервов.");
  }

  private async stockReservationRpc(fn: "issue_stock_reservation" | "return_stock_reservation", id: string, fallback: string): Promise<void> {
    const { error } = await this.db().rpc(fn, { p_reservation_id: id });
    if (error && (error as { readonly code?: string }).code === "PGRST202") {
      throw new M2ApiError(501, "Выдача и возврат заработают после обновления базы на сервере");
    }
    throwIfError(error, fallback);
  }

  public async operationsReport(from: string, to: string): Promise<OperationsReportRecord> {
    const bounds = reportPeriodBounds(from, to);
    // Все заявки периода, а не первые 1000: столько сервер отдаёт за один запрос.
    const [tasks, workTypesResult] = await Promise.all([
      allPages((start, end, withCount) => this.db().from("tasks")
        .select("id, status_code, work_type_code, deadline_to, completed_at, created_at", withCount ? { count: "exact" } : undefined)
        .gte("created_at", bounds.start).lte("created_at", bounds.end)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(start, end), "Не получилось построить отчёт"),
      this.db().from("work_types").select("code, name")
    ]);
    const workTypeNames = new Map((workTypesResult.error ? [] : workTypesResult.data ?? []).map((item) => {
      const row = asRow(item);
      return [text(row, "code"), text(row, "name")] as const;
    }));
    const byStatus = new Map<string, number>();
    const byType = new Map<string, number>();
    const byMonth = new Map<string, number>();
    let onTimeClosed = 0;
    let datedClosed = 0;
    for (const item of tasks) {
      const row = asRow(item);
      const status = text(row, "status_code");
      const type = text(row, "work_type_code");
      const created = (localDay(optionalText(row, "created_at") ?? iso(row.created_at)) ?? "").slice(0, 7);
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      byType.set(type, (byType.get(type) ?? 0) + 1);
      if (/^\d{4}-\d{2}$/u.test(created)) byMonth.set(created, (byMonth.get(created) ?? 0) + 1);
      if (status === "closed") {
        const onTime = closedOnTime(optionalText(row, "completed_at"), optionalText(row, "deadline_to"));
        if (onTime !== undefined) {
          datedClosed += 1;
          if (onTime) onTimeClosed += 1;
        }
      }
    }
    const closedCount = byStatus.get("closed") ?? 0;
    return {
      period: { from, to },
      metrics: {
        taskCount: tasks.length,
        closedCount,
        closedOnTimePercent: datedClosed ? Math.round((onTimeClosed / datedClosed) * 100) : 0,
        overdueCount: tasks.filter((item) => {
          const row = asRow(item);
          return reportTaskOverdue(optionalText(row, "deadline_to"), text(row, "status_code"), to);
        }).length,
        activeEngineerCount: 0,
        belowMinimumCount: 0
      },
      tasksByStatus: [...byStatus.entries()]
        .map(([code, value]) => ({ code, name: TASK_STATUS_LABELS[code] ?? "Статус", value }))
        .sort((left, right) => right.value - left.value),
      tasksByWorkType: [...byType.entries()]
        .map(([code, value]) => ({ code, name: workTypeNames.get(code) || (code ? "Вид работ" : "Не указан"), value }))
        .sort((left, right) => right.value - left.value),
      tasksByMonth: reportMonthsInRange(from, to).map((key) => ({
        key,
        name: reportMonthLabel(key),
        value: byMonth.get(key) ?? 0
      }))
    };
  }

  /**
   * Заявки за период для выгрузки в Excel: те же, что считает отчёт (созданные в периоде),
   * с площадкой, прибором и инженером. Читаем страницами по 1000, как отдаёт сервер.
   */
  public async operationsReportTasks(from: string, to: string): Promise<readonly ReportTaskRow[]> {
    const pageSize = 1000;
    const select = "id, number, title, status_code, priority, work_type_code, deadline_from, deadline_to, completed_at, created_at, "
      + "site:sites!site_id(name), device:equipment!equipment_id(serial_number, model:equipment_models(name), maker:manufacturers(name)), "
      + "engineer:users!engineer_id(full_name)";
    // Справочники и заявки читаем одновременно, а не друг за другом.
    const [workTypesResult, statusesResult, page] = await Promise.all([
      this.db().from("work_types").select("code, name"),
      this.db().from("task_statuses").select("code, name"),
      allPages((start, end, withCount) => this.db().from("tasks")
        .select(select, withCount ? { count: "exact" } : undefined)
        .gte("created_at", reportPeriodBounds(from, to).start).lte("created_at", reportPeriodBounds(from, to).end)
        .order("created_at", { ascending: true }).order("id", { ascending: true })
        .range(start, end), "Не получилось выгрузить заявки за период", pageSize)
    ]);
    const workTypeNames = new Map((workTypesResult.error ? [] : workTypesResult.data ?? []).map((item) => [text(asRow(item), "code"), text(asRow(item), "name")] as const));
    const statusNames = new Map((statusesResult.error ? [] : statusesResult.data ?? []).map((item) => [text(asRow(item), "code"), text(asRow(item), "name")] as const));
    const rows: ReportTaskRow[] = [];
    for (const item of page) {
      const row = asRow(item);
      const device = related(row, "device");
      const maker = optionalText(related(device, "maker"), "name");
      const model = optionalText(related(device, "model"), "name");
      const status = text(row, "status_code");
      const workType = optionalText(row, "work_type_code");
      rows.push({
        number: text(row, "number"),
        createdAt: optionalText(row, "created_at") ?? iso(row.created_at),
        title: text(row, "title"),
        status,
        statusName: statusNames.get(status) || TASK_STATUS_LABELS[status] || status,
        priority: text(row, "priority") === "urgent" ? "urgent" : "planned",
        ...(workType ? { workTypeName: workTypeNames.get(workType) || workType } : {}),
        ...(optionalText(related(row, "site"), "name") ? { siteName: optionalText(related(row, "site"), "name") } : {}),
        ...(maker || model ? { equipment: [maker, model].filter(Boolean).join(" ") } : {}),
        ...(optionalText(device, "serial_number") ? { serialNumber: optionalText(device, "serial_number") } : {}),
        ...(optionalText(related(row, "engineer"), "full_name") ? { engineerName: optionalText(related(row, "engineer"), "full_name") } : {}),
        ...(optionalText(row, "deadline_from") ? { periodFrom: optionalText(row, "deadline_from") } : {}),
        ...(optionalText(row, "deadline_to") ? { periodTo: optionalText(row, "deadline_to") } : {}),
        ...(optionalText(row, "completed_at") ? { completedAt: optionalText(row, "completed_at") } : {})
      });
    }
    return rows;
  }

  public async assignTask(id: string, engineerId: string, _comment?: string): Promise<TaskApiRecord> {
    const { error } = await this.db().from("tasks").update({ engineer_id: engineerId, status_code: "assigned" }).eq("id", id);
    throwIfError(error);
    return this.loadTask(id);
  }

  /** Сменить инженера у уже назначенной задачи (статус не меняется). */
  public async reassignTask(id: string, engineerId: string): Promise<TaskApiRecord> {
    const { error } = await this.db().from("tasks").update({ engineer_id: engineerId }).eq("id", id);
    throwIfError(error);
    return this.loadTask(id);
  }

  public async bulkAssignTasks(taskIds: readonly string[], engineerId: string): Promise<BulkTaskCommandResponse> {
    const succeededTaskIds: string[] = [];
    const failures: Array<{ readonly taskId: string; readonly code: "conflict" | "invalid_status" | "not_found"; readonly error: string }> = [];
    for (const taskId of taskIds) {
      try {
        await this.assignTask(taskId, engineerId);
        succeededTaskIds.push(taskId);
      } catch (caught) {
        failures.push({ taskId, code: "conflict", error: caught instanceof Error ? caught.message : "Не удалось назначить" });
      }
    }
    return {
      operation: "assignment",
      requestedCount: taskIds.length,
      successCount: succeededTaskIds.length,
      failureCount: failures.length,
      succeededTaskIds,
      failures
    };
  }

  public async bulkChangeTaskPeriod(taskIds: readonly string[], periodFrom: string, periodTo: string): Promise<BulkTaskCommandResponse> {
    const succeededTaskIds: string[] = [];
    const failures: Array<{ readonly taskId: string; readonly code: "conflict" | "invalid_status" | "not_found"; readonly error: string }> = [];
    for (const taskId of taskIds) {
      const { error } = await this.db().from("tasks").update({ deadline_from: periodFrom, deadline_to: periodTo }).eq("id", taskId);
      if (error) failures.push({ taskId, code: "conflict", error: error.message });
      else succeededTaskIds.push(taskId);
    }
    return {
      operation: "period_change",
      requestedCount: taskIds.length,
      successCount: succeededTaskIds.length,
      failureCount: failures.length,
      succeededTaskIds,
      failures
    };
  }

  /** Лёгкая проверка перед переносом на проверку: есть ли результат и акт (два запроса вместо полной карточки). */
  public async taskReviewReadiness(id: string): Promise<{ readonly hasClosure: boolean; readonly resultFilled: boolean }> {
    const [task, closure] = await Promise.all([
      this.db().from("tasks").select("call_reason, work_description").eq("id", id).maybeSingle(),
      this.db().from("task_closures").select("task_id").eq("task_id", id).maybeSingle()
    ]);
    throwIfError(task.error);
    throwIfError(closure.error);
    const row = task.data ? asRow(task.data) : {};
    return {
      hasClosure: Boolean(closure.data),
      resultFilled: Boolean(optionalText(row, "call_reason")?.trim() && optionalText(row, "work_description")?.trim())
    };
  }

  /**
   * Запоминает места карточек в колонке доски. Саму задачу не меняет: место хранится отдельно
   * и действует, пока задача в этом этапе.
   */
  public async setTaskBoardPositions(status: string, positions: readonly { readonly taskId: string; readonly position: number }[]): Promise<void> {
    if (positions.length === 0) return;
    if (!boardOrderAvailable) throw new M2ApiError(400, "Порядок карточек пока не сохраняется: на сервере не обновлена база");
    if (positions.some((item) => !Number.isFinite(item.position))) throw new M2ApiError(400, "Не получилось вычислить место карточки");
    const { error } = await this.db().from("task_board_positions").upsert(
      positions.map((item) => ({ task_id: item.taskId, status_code: status, position: item.position })),
      { onConflict: "task_id" }
    );
    if (!error) return;
    const blob = [error.message, error.code, error.details, error.hint].filter(Boolean).join(" ");
    if (/task_board_positions/iu.test(blob) && /PGRST205|42P01|schema cache|does not exist/iu.test(blob)) {
      throw new M2ApiError(400, "Порядок карточек пока не сохраняется: на сервере не обновлена база");
    }
    if (error.code === "42501" || /row-level security/iu.test(blob)) {
      // Права на доске проверены заранее, поэтому чаще всего карточка уже в другом этапе.
      throw new M2ApiError(403, "Порядок не сохранился: доска устарела или нет прав на эти задачи. Обновите доску");
    }
    throwIfError(error, "Не получилось сохранить порядок карточек");
  }

  public async transitionTask(id: string, status: string, details: Readonly<Record<string, string>> = {}): Promise<TaskApiRecord> {
    const patch: Row = { status_code: status };
    if (details.cancellationReason) patch.cancellation_reason = details.cancellationReason;
    if (details.reworkComment) patch.rework_comment = details.reworkComment;
    const { error } = await this.db().from("tasks").update(patch).eq("id", id);
    throwIfError(error);
    return this.loadTask(id);
  }

  public async acceptTaskClosure(id: string, verificationComment?: string): Promise<TaskApiRecord> {
    const actor = await this.actorId();
    const { error } = await this.db().rpc("accept_task_closure", {
      p_task_id: id,
      p_verified_by: actor,
      p_verification_comment: verificationComment ?? null,
      p_updated_at: new Date().toISOString()
    });
    throwIfError(error);
    return this.loadTask(id);
  }

  public async taskAssignmentSuggestions(_id: string, manufacturer: string, modelLine?: string): Promise<readonly AssignmentSuggestionRecord[]> {
    const engineers = await this.engineers();
    return engineers.map((engineer) => ({
      engineerId: engineer.id,
      fullName: engineer.fullName,
      isAvailable: engineer.inProgressTaskCount === 0,
      previouslyWorkedWithEquipment: engineer.competencies.some((competency) => competency.manufacturer === manufacturer && (!modelLine || competency.modelLine === modelLine))
    }));
  }

  public async listInvoices(): Promise<readonly InvoiceApiRecord[]> {
    const { data, error } = await this.db().from("invoices").select("id, number, status, created_at, updated_at, payer_id, payer:payers!payer_id(id, name, requisites), invoice_tasks(task_id)").order("created_at", { ascending: false });
    throwIfError(error);
    return (data ?? []).map((item) => {
      const row = asRow(item);
      const payer = related(row, "payer");
      const items = Array.isArray(row.invoice_tasks) ? row.invoice_tasks : [];
      return {
        id: text(row, "id"),
        number: text(row, "number"),
        status: text(row, "status") as InvoiceApiRecord["status"],
        taskIds: items.map((entry) => text(asRow(entry), "task_id")).filter(Boolean),
        payer: {
          id: text(payer, "id") || text(row, "payer_id"),
          name: text(payer, "name"),
          requisites: asRow(payer.requisites) as Record<string, string>
        },
        payerSelection: { source: "equipment" },
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
      };
    });
  }

  public async createInvoice(input: Readonly<Record<string, unknown>>): Promise<InvoiceApiRecord> {
    const taskIds = Array.isArray(input.taskIds) ? input.taskIds as readonly string[] : [];
    if (!input.payerId) throw new M2ApiError(400, "Выберите плательщика");
    if (!taskIds.length) throw new M2ApiError(400, "Выберите хотя бы одну закрытую задачу");
    const overrideReason = typeof input.payerOverrideReason === "string" ? input.payerOverrideReason.trim() : "";
    // Счёт и привязка задач одной операцией в базе (миграция 0015): при ошибке
    // не остаётся пустого черновика, прибор-источник и автор замены выбирает база.
    const { data, error } = await this.db().rpc("create_invoice", {
      p_payer_id: input.payerId,
      p_task_ids: [...taskIds],
      p_payer_override_reason: overrideReason || null
    });
    throwIfError(error, "Не получилось создать счёт");
    const invoiceId = typeof data === "string" ? data : "";
    if (!invoiceId) throw new M2ApiError(500, "Счёт не создан");
    const invoices = await this.listInvoices();
    const created = invoices.find((item) => item.id === invoiceId);
    if (!created) throw new M2ApiError(500, "Счёт не создан");
    return created;
  }

  /** Отмена счёта вместо удаления (миграция 0024): счёт остаётся в списке, его задачи можно выставить снова. */
  public async cancelInvoice(id: string): Promise<void> {
    const { data, error } = await this.db().from("invoices").update({ status: "cancelled" }).eq("id", id).in("status", ["draft", "issued"]).select("id");
    throwIfError(error, "Не получилось отменить счёт");
    if (!Array.isArray(data) || data.length === 0) throw new M2ApiError(409, "Счёт не отменён: его уже отменили или передали в 1С. Обновите страницу.");
  }

  public async listCatalogs(): Promise<readonly ReferenceCatalogDescriptor[]> {
    return CATALOGS;
  }

  public async listCatalogValues(key: string): Promise<readonly ReferenceCatalogValue[]> {
    const cached = this.catalogCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    const value = this.fetchCatalogValues(key);
    this.catalogCache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.catalogCache.get(key)?.value === value) this.catalogCache.delete(key); });
    return value;
  }

  private async fetchCatalogValues(key: string): Promise<readonly ReferenceCatalogValue[]> {
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    const { data, error } = await this.db().from(catalog.table).select("*").order("sort_order").order("name");
    throwIfError(error);
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return {
        id: text(row, catalog.id),
        code: catalog.code ? optionalText(row, catalog.code) : undefined,
        name: text(row, "name"),
        isActive: row.is_active !== false,
        attributes: {
          ...(row.requires_hours !== undefined ? { requiresHours: row.requires_hours === true } : {}),
          ...(row.sort_order !== undefined ? { sortOrder: numberValue(row.sort_order) ?? 0 } : {}),
          ...(row.is_terminal !== undefined ? { isTerminal: row.is_terminal === true } : {}),
          ...(row.manufacturer_id !== undefined ? { manufacturerId: optionalText(row, "manufacturer_id") ?? null } : {}),
          ...(row.category !== undefined ? { category: optionalText(row, "category") ?? null } : {}),
          ...(row.supplier_warranty_months !== undefined ? { supplierWarrantyMonths: numberValue(row.supplier_warranty_months) ?? null } : {}),
          ...(row.supplier_coverage_percent !== undefined ? { supplierCoveragePercent: numberValue(row.supplier_coverage_percent) ?? null } : {})
        }
      };
    });
  }

  public async createCatalogValue(key: string, input: Readonly<Record<string, unknown>>): Promise<ReferenceCatalogValue> {
    this.catalogCache.delete(key);
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    const attributes = asRow(input.attributes);
    const payload: Row = { name: input.name, is_active: input.isActive !== false };
    if (catalog.code && input.code) payload[catalog.code] = input.code;
    if (key === "work-types") payload.requires_hours = text(asRow({ code: input.code }), "code") === "other";
    applyCatalogAttributes(payload, attributes);
    if (payload.sort_order === undefined) {
      const existing = await this.listCatalogValues(key);
      const maxOrder = existing.reduce((max, item) => Math.max(max, numberValue(item.attributes.sortOrder) ?? 0), 0);
      payload.sort_order = maxOrder + 10;
    }
    const { error } = await this.db().from(catalog.table).insert(payload);
    this.catalogCache.delete(key);
    throwIfError(error);
    const values = await this.listCatalogValues(key);
    const created = values.find((item) => item.name === input.name);
    if (!created) throw new M2ApiError(500, "Значение справочника не создано");
    return created;
  }

  public async updateCatalogValue(key: string, id: string, input: Readonly<Record<string, unknown>>): Promise<ReferenceCatalogValue> {
    this.catalogCache.delete(key);
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    const patch: Row = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.attributes !== undefined) applyCatalogAttributes(patch, asRow(input.attributes));
    const { error } = await this.db().from(catalog.table).update(patch).eq(catalog.id, id);
    this.catalogCache.delete(key);
    throwIfError(error);
    const values = await this.listCatalogValues(key);
    const updated = values.find((item) => item.id === id);
    if (!updated) throw new M2ApiError(404, "Значение справочника не найдено");
    return updated;
  }

  public async moveCatalogValue(key: string, id: string, direction: "up" | "down"): Promise<readonly ReferenceCatalogValue[]> {
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    this.catalogCache.delete(key);
    const values = [...await this.listCatalogValues(key)];
    this.catalogCache.delete(key);
    const index = values.findIndex((item) => item.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= values.length) return values;
    const [moved] = values.splice(index, 1);
    if (!moved) return values;
    values.splice(target, 0, moved);
    const results = await Promise.all(values.map((item, position) =>
      this.db().from(catalog.table).update({ sort_order: (position + 1) * 10 }).eq(catalog.id, item.id)
    ));
    this.catalogCache.delete(key);
    for (const result of results) throwIfError(result.error);
    return this.listCatalogValues(key);
  }

  public async removeCatalogValue(key: string, id: string): Promise<{ readonly mode: "deactivated" | "deleted"; readonly after?: ReferenceCatalogValue }> {
    const after = await this.updateCatalogValue(key, id, { isActive: false });
    return { mode: "deactivated", after };
  }
}

export const m2Api = new M2ApiClient();
