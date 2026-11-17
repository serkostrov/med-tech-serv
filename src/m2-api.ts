import type { Permission, WorkingRole } from "./domain/access.js";
import { availableTaskActions, type AvailableTaskAction } from "./domain/task-actions.js";
import { TASK_STATUS_LABELS } from "./domain/task-status.js";
import { companyDay, companyDayEnd, companyDayStart, companyToday, taskCalendarDate } from "./task-dates.js";
import type { EquipmentHistoryEvent, EquipmentHistoryEventType, EquipmentHistoryPart } from "./domain/equipment-history.js";
import { assertAnnualMaintenancePlan, maintenancePeriodOnYearTimeline } from "./domain/maintenance-plan.js";
import { competencyMatchesEquipment, competencyPayload, sortCompetencies, type EngineerCompetency } from "./engineer-competencies.js";
import {
  assignmentLoadRange,
  periodLoadFromCounts,
  type CalendarEngineer,
  type CalendarTask,
  type EngineerPeriodLoad
} from "./engineer-calendar.js";
import { getSupabase, type AppSupabaseClient } from "./lib/supabase.js";
import { auditActionCodesForSearch, loginFailureReason, type AuditJournalPage, type LoginJournalPage } from "./audit-journal.js";
import { canReadWholeNotificationJournal } from "./notification-journal.js";
import { assertReferenceValueCanBeHidden } from "./reference-edit.js";
import { assertRequisites } from "./requisites.js";
import { invoiceWorkDate } from "./invoice-card.js";
import { taskMailReplyRefusal } from "./task-mail.js";
import { isStockDocumentKind, type StockDocumentKind, type StockDocumentLine, type StockDocumentPage, type StockDocumentRecord } from "./stock-documents.js";
import {
  importSerialKey,
  type ImportExistingEquipment,
  type ImportSnapshot,
  type ImportWriteEquipment,
  type ImportWriteEvent,
  type ImportWriteResult
} from "./import-1c.js";
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
  TaskMailAttachment,
  TaskMailMessage,
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
  /** Дополнительные виды работ (0060): у задачи «инсталляция и ремонт» основной — первый. */
  readonly extraWorkTypeCodes?: readonly string[];
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
  /**
   * Занятость инженера на период назначаемой задачи (функция engineer_period_load, 0051).
   * Пусто, если в базе функции ещё нет: тогда подсказка остаётся прежней, по компетенциям.
   */
  readonly load?: EngineerPeriodLoad;
}

/** Задачи и инженеры календаря загрузки за период: готовы для buildEngineerCalendar. */
export interface EngineerCalendarData {
  readonly engineers: readonly CalendarEngineer[];
  readonly tasks: readonly CalendarTask[];
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
  /** Даты выставления и передачи в 1С. Приходят в карточке счёта: списку они не нужны. */
  readonly issuedAt?: string;
  readonly transferredAt?: string;
}

/**
 * Строка счёта: работа или запчасть. Суммы считает база (`line_total` — её столбец),
 * гарантийная строка видна в счёте, но в сумму не идёт (`excludedFromTotal`).
 */
export interface InvoiceItemApiRecord {
  readonly id: string;
  readonly itemType: "work" | "part";
  readonly taskId: string | null;
  readonly taskNumber: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineTotal: number;
  readonly modifier: "G" | "N" | null;
  readonly excludedFromTotal: boolean;
  /** День работ по задаче, на который база взяла цену из прайса. Нет задачи — null. */
  readonly workDate?: string | null;
}

export interface InvoiceCardResponse {
  readonly invoice: InvoiceApiRecord;
  readonly items: readonly InvoiceItemApiRecord[];
  readonly subtotal: number;
  readonly adjustmentAmount: number;
  readonly totalAmount: number;
  readonly correctionReason: string | null;
  readonly statusHistory: readonly { readonly status: string; readonly at: string; readonly actorName: string | null }[];
}

/**
 * Строка прайса: цена вида работ, действующая с `validFrom` по `validTo`
 * (`null` — действует сейчас). Прошлые строки остаются с заполненным `validTo`: это история цен.
 * `guaranteeCategoryId` пустой — цена для всех категорий гарантии.
 */
export interface PriceRowApiRecord {
  readonly id: string;
  readonly workTypeCode: string;
  readonly guaranteeCategoryId: string | null;
  /** ГГГГ-ММ-ДД */
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly amount: number;
  readonly includeGuaranteeWork: boolean;
  readonly createdAt: string;
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
  /**
   * Встроенное значение: на нём держится работа базы, отключать и удалять его нельзя (миграция 0033).
   * У справочников без такого признака поля нет вовсе, поэтому необязательное.
   */
  readonly isBuiltin?: boolean;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EngineerOverview {
  readonly id: string;
  readonly fullName: string;
  readonly isActive: boolean;
  readonly competencies: readonly EngineerCompetency[];
  readonly assignedTaskCount: number;
  readonly inProgressTaskCount: number;
  readonly overdueTaskCount: number;
}

/** Количество по состояниям запчасти: гарантийная, новая, б/у. */
export type PartConditionTotals = Readonly<Record<"G" | "N" | "B", number>>;

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
  /** Артикулы поставщиков этой запчасти одной строкой (миграция 0047); пусто — псевдонимов нет. */
  readonly aliases?: string;
  /** На складе по состояниям Г, Н и Б (миграция 0050): резервируют и выдают именно в состоянии. */
  readonly onHandByCondition: PartConditionTotals;
  /** Доступно (на складе минус резерв) по тем же состояниям. */
  readonly availableByCondition: PartConditionTotals;
}

/** Движение по позиции склада из истории (функция inventory_part_movements, миграция 0048). */
export interface StockMovementRecord {
  readonly id: string;
  readonly type: StockMovementType;
  readonly condition: "G" | "N" | "B";
  readonly quantity: number;
  /** Насколько изменился остаток: приход и возврат в плюс, выдача и списание в минус, резерв и установка ноль. */
  readonly delta: number;
  /** Остаток в этом состоянии сразу после движения. */
  readonly onHandAfter: number;
  readonly occurredAt: string;
  readonly comment?: string;
  readonly actorName?: string;
  readonly taskId?: string;
  readonly taskNumber?: string;
  readonly reservationNumber?: string;
  readonly equipmentSerialNumber?: string;
  readonly lotCode?: string;
}

/** Тип движения склада (stock_movement_type в базе). */
export type StockMovementType = "receipt" | "reserve" | "issue" | "install" | "writeoff" | "return" | "adjustment";

export interface StockMovementPage {
  readonly items: readonly StockMovementRecord[];
  readonly total: number;
}

/** Псевдоним артикула: тот же артикул у другого поставщика (таблица part_aliases). */
export interface PartAliasRecord {
  readonly id: string;
  readonly alias: string;
  readonly createdAt: string;
}

/**
 * Строка накладной, как её принимает база (0050): клетки файла как есть, число может
 * прийти и строкой («2,5») — разбирает их сама база, одинаково для предпросмотра и прихода.
 */
export interface StockReceiptInputRow {
  /** Номер строки в файле: по нему человек находит строку с ошибкой. */
  readonly row?: number;
  readonly article: string;
  readonly quantity: string | number;
  readonly condition?: string;
  readonly unit_price?: string | number;
  readonly comment?: string;
}

/** Строка накладной, как её разобрала база (preview_stock_receipt, миграция 0050). */
export interface StockReceiptPreviewRow {
  readonly rowNo: number;
  readonly article: string;
  readonly partId?: string;
  readonly partArticle?: string;
  readonly partName?: string;
  /** По артикулу самой запчасти или по псевдониму поставщика. */
  readonly matchedBy?: "article" | "alias";
  readonly condition?: "G" | "N" | "B";
  readonly quantity?: number;
  readonly unitPrice?: number;
  readonly comment?: string;
  /** Что не так именно с этой строкой; пусто — строка готова к приходу. */
  readonly error?: string;
}

/** Оприходованная строка накладной: сколько стало на складе по этой позиции и состоянию. */
export interface StockReceiptAppliedRow {
  readonly partId: string;
  readonly partArticle: string;
  readonly partName: string;
  readonly condition: "G" | "N" | "B";
  readonly quantity: number;
  readonly onHandAfter: number;
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

/**
 * Шаг резерва из stock_reservation_history: в какой статус перевели, кто и когда.
 * Пустой список означает, что истории ещё нет (или база её пока не отдаёт).
 */
export interface StockReservationStep {
  readonly status: StockReservationStatus;
  readonly fromStatus?: StockReservationStatus;
  readonly changedAt: string;
  readonly actorName?: string;
}

export interface StockReservationRecord {
  readonly id: string;
  readonly number: string;
  readonly status: StockReservationStatus;
  readonly partId: string;
  readonly articleNumber: string;
  readonly partName: string;
  readonly condition: "G" | "N" | "B";
  readonly quantity: number;
  /** Артикулы этой запчасти у других поставщиков (0047): по ним тоже ищут в окне резервов. */
  readonly aliases?: readonly string[];
  readonly taskId?: string;
  readonly taskNumber?: string;
  readonly taskTitle?: string;
  /** Этап задачи (status_code): по отменённой или закрытой задаче выдавать не нужно. */
  readonly taskStatus?: string;
  /** Инженер задачи: ему выдаётся запчасть. */
  readonly engineerName?: string;
  /** Кому выдали на самом деле (после выдачи). */
  readonly issuedToName?: string;
  /** Инженер отметил, что эта запчасть встала на прибор (stock_reservations.install_marked). */
  readonly installMarked: boolean;
  /** Шаги резерва по порядку: от «Ждёт сборки» до последнего состояния. */
  readonly steps: readonly StockReservationStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Строка разреза отчёта: сколько заявок, сколько из них закрыто и сколько просрочено. */
export interface ReportCutItem {
  readonly code: string;
  readonly name: string;
  readonly value: number;
  readonly closed: number;
  readonly overdue: number;
}

/** Гарантийность замен запчастей: Г (гарантийная), Н (новая), Б (бывшая в употреблении). */
export interface ReportPartConditionItem {
  readonly code: string;
  readonly name: string;
  readonly taskCount: number;
  readonly positionCount: number;
  readonly quantity: number;
}

/** Загрузка одного инженера за период: задачи и занятые дни из периода. */
export interface ReportEngineerLoadItem {
  readonly engineerId: string;
  readonly name: string;
  readonly taskCount: number;
  readonly closedCount: number;
  readonly overdueCount: number;
  readonly busyDays: number;
  readonly periodDays: number;
  readonly workHours: number;
}

/** Затраты по прибору или плательщику за период. Видны только с правом `finance.read`. */
export interface ReportSpendItem {
  readonly id: string;
  readonly name: string;
  /** Вторая строка в ячейке: у прибора — его площадка и плательщик. */
  readonly detail?: string;
  readonly taskCount: number;
  readonly invoiceCount: number;
  readonly workAmount: number;
  readonly partsAmount: number;
  /** Ручная корректировка счёта: только в разрезе по плательщикам. */
  readonly adjustmentAmount?: number;
  readonly totalAmount: number;
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
  /** Причины обращений из акта: износ, вина пользователя, гарантийный случай. */
  readonly tasksByReason: readonly ReportCutItem[];
  /** Гарантийность работ: Г, Н и «не отмечено». */
  readonly worksByModifier: readonly ReportCutItem[];
  readonly tasksByEquipment: readonly ReportCutItem[];
  readonly tasksBySite: readonly ReportCutItem[];
  readonly tasksByEngineer: readonly ReportCutItem[];
  readonly partsByCondition: readonly ReportPartConditionItem[];
  readonly engineerLoad: readonly ReportEngineerLoadItem[];
  readonly equipmentSpend: readonly ReportSpendItem[];
  readonly payerSpend: readonly ReportSpendItem[];
  /** Деньги в отчёте показываем только с правом `finance.read`. */
  readonly canSeeFinance: boolean;
  /**
   * Разрезы считает база (миграция 0044). Пока её нет на сервере, остаются прежние
   * цифры, посчитанные в браузере, а новые разрезы пустые.
   */
  readonly databaseCuts: boolean;
  /**
   * Затраты считает база (миграция 0045). Миграции применяют по одной, и 0045 может
   * отстать от 0044: тогда разрезы по задачам уже есть, а денег ещё нет, и говорить
   * «счетов за период нет» было бы неправдой.
   */
  readonly databaseSpend: boolean;
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
  /** Время окончания работ из результата: только с ним в отчёте показываем время окончания. */
  readonly workFinishedAt?: string;
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

/** Поля журнала изменений (представление audit_log_journal, 0057). */
const AUDIT_JOURNAL_SELECT = "id, occurred_at, actor_type, actor_user_id, actor_name, action, outcome, entity_type, entity_id, table_name, changed_fields, before_data, after_data, metadata, money_hidden, ip_address";

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
  // Удаление периода, по которому уже создана задача (старый путь сохранения плана).
  if (/task_maintenance_plan_equipment_fk/iu.test(text) && /update or delete on table "?maintenance_plans/iu.test(text)) {
    return "По этому прибору уже созданы задачи из плана: периоды с задачами нельзя изменить или удалить.";
  }
  // Этап задачи выключен в справочнике статусов (например, «Запланирована» для задач из плана ТО).
  const inactiveStatus = /Статус задачи не активен: (\w+)/u.exec(text);
  if (inactiveStatus) {
    // Название как в справочнике и на доске: «Запланировано», а не «Запланирована».
    const code = inactiveStatus[1] ?? "";
    const label = code === "planned" ? "Запланировано" : TASK_STATUS_LABELS[code] ?? code;
    return `Этап «${label}» выключен в справочнике статусов задач. Включите его в «Справочниках».`;
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
  if (/equipment_serial_number_normalized_uq/iu.test(text)) {
    return "Прибор с таким S/N уже есть в реестре. Регистр и пробелы при проверке не учитываются.";
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

function reservationStatus(value: string | undefined): StockReservationStatus | undefined {
  return value && (RESERVATION_STATUSES as readonly string[]).includes(value) ? value as StockReservationStatus : undefined;
}

/**
 * Шаги резерва из встроенной stock_reservation_history по порядку времени.
 * Имя автора приходит из users по changed_by; если его не встроили, остаётся только время.
 */
function reservationSteps(value: unknown): readonly StockReservationStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = asRow(item);
      const status = reservationStatus(optionalText(row, "to_status"));
      if (!status) return undefined;
      const fromStatus = reservationStatus(optionalText(row, "from_status"));
      const actorName = optionalText(related(row, "changer"), "full_name");
      return {
        status,
        ...(fromStatus ? { fromStatus } : {}),
        changedAt: iso(row.changed_at),
        ...(actorName ? { actorName } : {})
      } satisfies StockReservationStep;
    })
    .filter((step): step is StockReservationStep => step !== undefined)
    .sort((left, right) => left.changedAt.localeCompare(right.changedAt));
}

/**
 * Строка stock_reservations со встроенными запчастью, задачей и инженерами. Задачу кладовщик
 * видит, пока резерв действует: у закрытых резервов задача приходит пустой.
 */
export function stockReservationRecord(row: Row): StockReservationRecord {
  const part = asRow(row.part);
  // Псевдонимы артикула: в строке их не показываем (она и так длинная), но по ним ищут.
  const aliases = (Array.isArray(part.part_aliases) ? part.part_aliases : [])
    .map((item) => text(asRow(item), "alias").trim()).filter(Boolean);
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
    ...(aliases.length ? { aliases } : {}),
    ...(taskId ? { taskId } : {}),
    ...(taskNumber ? { taskNumber } : {}),
    ...(taskTitle ? { taskTitle } : {}),
    ...(taskStatus ? { taskStatus } : {}),
    ...(engineerName ? { engineerName } : {}),
    ...(issuedToName ? { issuedToName } : {}),
    installMarked: row.install_marked === true,
    steps: reservationSteps(row.stock_reservation_history ?? row.history),
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

/**
 * Слова поиска по складу и приборам: строка подходит, если нашлось каждое слово (в любом поле).
 * «ё» ищем как «е»: так записан текст для поиска в базе (миграция 0025). Больше 10 слов не берём.
 */
export function searchTokens(value: string | undefined): readonly string[] {
  // «*» PostgREST в ilike читает как «любые символы»: убираем, иначе «*» находит всё.
  return (value ?? "").replace(/[Ёё]/gu, "е").replace(/\*/gu, " ").split(/\s+/u).filter(Boolean).slice(0, 10);
}

/**
 * Шаблон ilike для слова поиска по столбцу search_text. Это обычный фильтр, а не `.or(...)`,
 * поэтому запятые, точки и скобки остаются (артикул «6.1234.56»), а % _ \ ищутся как знаки.
 */
export function searchTextPattern(token: string): string {
  return `%${escapeIlikePattern(token)}%`;
}

/**
 * Запчасть из details события «Замена запчасти»: артикул, наименование, количество и Г/Н/Б.
 * Старые события без этих полей остаются без запчасти.
 */
function historyPartDetails(details: Row): EquipmentHistoryPart | undefined {
  const articleNumber = optionalText(details, "articleNumber");
  const name = optionalText(details, "partName");
  const quantity = numberValue(details.quantity);
  const conditionText = optionalText(details, "condition");
  const condition = conditionText === "G" || conditionText === "N" || conditionText === "B" ? conditionText : undefined;
  if (!articleNumber && !name && quantity === undefined && !condition) return undefined;
  return {
    ...(articleNumber ? { articleNumber } : {}),
    ...(name ? { name } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(condition ? { condition } : {})
  };
}

/** Функции из новой миграции в базе ещё нет: PostgREST отвечает PGRST202. */
function isMissingDatabaseFunction(error: { readonly code?: string } | null): boolean {
  return (error as { readonly code?: string } | null)?.code === "PGRST202";
}

/**
 * Ошибка из-за того, что представления или функции из новой миграции ещё нет в базе
 * (или PostgREST её ещё не видит). Тогда список работает по-старому, а не падает.
 */
function isMissingSchemaObject(
  error: { readonly message?: string; readonly code?: string; readonly details?: string; readonly hint?: string } | null,
  name: string
): boolean {
  if (!error) return false;
  const blob = [error.message, error.code, error.details, error.hint].filter(Boolean).join(" ");
  // Только «объекта нет» (представления или функции): ошибки столбцов и связей не прячем за старый путь.
  const missing = blob.includes(name) && /PGRST20[25]|42P01|42883|could not find the (table|function)|relation .* does not exist|function .* does not exist/iu.test(blob);
  if (missing) console.warn(`В базе нет ${name}: работаем по-старому, пока не применена миграция 0025`);
  return missing;
}

const RESERVATION_SELECT = "id, number, status, part_id, part_condition, quantity, task_id, created_at, updated_at, "
  + "task:tasks(number, title, status_code, engineer:users!engineer_id(full_name)), issued:users!issued_to(full_name)";

/**
 * Запчасть резерва. С псевдонимами артикулов (0047): поиск в окне резервов должен находить
 * запчасть по артикулу любого поставщика, как и склад. Таблицы псевдонимов в API нет —
 * читаем запчасть без них, поиск останется по артикулу и наименованию.
 */
const RESERVATION_PART_SELECTS: readonly string[] = [
  "part:parts(article_number, name, part_aliases(alias))",
  "part:parts(article_number, name)"
];

/** Отметка «установлена» живёт в самом резерве (миграция 0028), а не в запчастях задачи. */
const RESERVATION_MARK_SELECT = "install_marked";

/**
 * Шаги резерва: сначала с автором по FK changed_by → users, затем без него, затем вовсе без
 * истории (миграция 0028). Чем старее база, тем дальше по списку.
 */
const RESERVATION_HISTORY_SELECTS: readonly string[] = [
  "stock_reservation_history(from_status, to_status, changed_at, changed_by, changer:users!changed_by(full_name))",
  "stock_reservation_history(from_status, to_status, changed_at, changed_by)",
  ""
];

const TASK_PART_SELECT = "id, article_number_snapshot, name_snapshot, quantity, part_condition";

const PART_SELECT = "id, article_number, name, minimum_stock, notes, is_active";

/** Столбцы представления склада inventory_part_registry (миграция 0025): остатки уже посчитаны базой. */
const INVENTORY_REGISTRY_SELECT = `${PART_SELECT}, on_hand_quantity, reserved_quantity, available_quantity, with_engineers_quantity, below_minimum`;

/**
 * Псевдонимы артикулов (0047) и остатки по состояниям (0050). В базе без этих миграций
 * таких столбцов нет, и запрос с ними падает ошибкой столбца — тогда читаем склад без них:
 * список работает, просто без колонки Г/Н/Б. Так же устроены шаги резерва.
 */
const INVENTORY_REGISTRY_EXTRA_SELECT = "aliases, on_hand_guarantee, on_hand_new, on_hand_used, "
  + "available_guarantee, available_new, available_used";

type SortColumns = readonly (readonly [column: string, ascending: boolean])[];

/** По наименованию: так склад упорядочен, если сортировку не выбрали (и так было раньше). */
const DEFAULT_INVENTORY_SORT: SortColumns = [["name", true], ["article_number", true], ["id", true]];

/**
 * Сортировки окна «Склад». Последние столбцы решают при равных значениях,
 * чтобы строки не перескакивали между страницами.
 */
const INVENTORY_SORTS: ReadonlyMap<string, SortColumns> = new Map<string, SortColumns>([
  ["article_asc", [["article_number", true], ["id", true]]],
  ["article_desc", [["article_number", false], ["id", false]]],
  ["name_asc", DEFAULT_INVENTORY_SORT],
  ["available_asc", [["available_quantity", true], ["article_number", true], ["id", true]]],
  ["available_desc", [["available_quantity", false], ["article_number", true], ["id", true]]]
]);

/** Строка склада: из представления 0025 или собранная из parts, stock_balances и выданных резервов. */
function inventoryPartRecord(row: Row): InventoryPartRecord {
  const minimumStock = numberValue(row.minimum_stock) ?? 0;
  const availableQuantity = numberValue(row.available_quantity) ?? 0;
  const aliases = optionalText(row, "aliases");
  return {
    id: text(row, "id"),
    articleNumber: text(row, "article_number"),
    name: text(row, "name"),
    minimumStock,
    notes: optionalText(row, "notes"),
    isActive: row.is_active !== false,
    onHandQuantity: numberValue(row.on_hand_quantity) ?? 0,
    reservedQuantity: numberValue(row.reserved_quantity) ?? 0,
    availableQuantity,
    withEngineersQuantity: numberValue(row.with_engineers_quantity) ?? 0,
    belowMinimum: typeof row.below_minimum === "boolean" ? row.below_minimum : availableQuantity < minimumStock,
    ...(aliases ? { aliases } : {}),
    onHandByCondition: {
      G: numberValue(row.on_hand_guarantee) ?? 0,
      N: numberValue(row.on_hand_new) ?? 0,
      B: numberValue(row.on_hand_used) ?? 0
    },
    availableByCondition: {
      G: numberValue(row.available_guarantee) ?? 0,
      N: numberValue(row.available_new) ?? 0,
      B: numberValue(row.available_used) ?? 0
    }
  };
}

const MOVEMENT_TYPES: readonly StockMovementType[] = ["receipt", "reserve", "issue", "install", "writeoff", "return", "adjustment"];

/** Строка истории движений из функции базы (0048). */
function stockMovementRecord(row: Row): StockMovementRecord {
  const typeText = text(row, "movement_type");
  const conditionText = text(row, "part_condition");
  return {
    id: text(row, "id"),
    type: (MOVEMENT_TYPES as readonly string[]).includes(typeText) ? typeText as StockMovementType : "adjustment",
    condition: conditionText === "G" || conditionText === "B" ? conditionText : "N",
    quantity: numberValue(row.quantity) ?? 0,
    delta: numberValue(row.on_hand_delta) ?? 0,
    onHandAfter: numberValue(row.on_hand_after) ?? 0,
    occurredAt: text(row, "occurred_at"),
    ...(optionalText(row, "comment") ? { comment: optionalText(row, "comment") as string } : {}),
    ...(optionalText(row, "performed_by_name") ? { actorName: optionalText(row, "performed_by_name") as string } : {}),
    ...(optionalText(row, "task_id") ? { taskId: optionalText(row, "task_id") as string } : {}),
    ...(optionalText(row, "task_number") ? { taskNumber: optionalText(row, "task_number") as string } : {}),
    ...(optionalText(row, "reservation_number") ? { reservationNumber: optionalText(row, "reservation_number") as string } : {}),
    ...(optionalText(row, "equipment_serial_number") ? { equipmentSerialNumber: optionalText(row, "equipment_serial_number") as string } : {}),
    ...(optionalText(row, "lot_code") ? { lotCode: optionalText(row, "lot_code") as string } : {})
  };
}

/** Документ склада из функции базы (0062). */
function stockDocumentRecord(row: Row): StockDocumentRecord {
  const kindText = text(row, "kind");
  const optional = (key: string, field: string) => optionalText(row, key) ? { [field]: optionalText(row, key) as string } : {};
  return {
    id: text(row, "id"),
    number: text(row, "number"),
    kind: isStockDocumentKind(kindText) ? kindText : "writeoff",
    date: text(row, "document_date"),
    ...optional("task_id", "taskId"),
    ...optional("task_number", "taskNumber"),
    ...optional("task_title", "taskTitle"),
    ...optional("equipment_serial_number", "equipmentSerialNumber"),
    ...optional("equipment_name", "equipmentName"),
    ...optional("site_name", "siteName"),
    ...optional("engineer_name", "engineerName"),
    lineCount: numberValue(row.line_count) ?? 0,
    totalQuantity: numberValue(row.total_quantity) ?? 0
  } as StockDocumentRecord;
}

/** Строка документа склада из функции базы (0062). */
function stockDocumentLine(row: Row): StockDocumentLine {
  const conditionText = text(row, "part_condition");
  return {
    documentId: text(row, "document_id"),
    movementId: text(row, "movement_id"),
    articleNumber: text(row, "article_number"),
    partName: text(row, "part_name"),
    condition: conditionText === "G" || conditionText === "B" ? conditionText : "N",
    quantity: numberValue(row.quantity) ?? 0,
    occurredAt: text(row, "occurred_at"),
    ...(optionalText(row, "reservation_number") ? { reservationNumber: optionalText(row, "reservation_number") as string } : {}),
    ...(optionalText(row, "comment") ? { comment: optionalText(row, "comment") as string } : {})
  };
}

/** Строка разбора накладной из функции базы (0050). */
function stockReceiptPreviewRow(row: Row): StockReceiptPreviewRow {
  const matchedBy = optionalText(row, "matched_by");
  const conditionText = optionalText(row, "part_condition");
  const quantity = numberValue(row.quantity);
  const unitPrice = numberValue(row.unit_price);
  return {
    rowNo: numberValue(row.row_no) ?? 0,
    article: text(row, "article"),
    ...(optionalText(row, "part_id") ? { partId: optionalText(row, "part_id") as string } : {}),
    ...(optionalText(row, "part_article") ? { partArticle: optionalText(row, "part_article") as string } : {}),
    ...(optionalText(row, "part_name") ? { partName: optionalText(row, "part_name") as string } : {}),
    ...(matchedBy === "article" || matchedBy === "alias" ? { matchedBy } : {}),
    ...(conditionText === "G" || conditionText === "N" || conditionText === "B" ? { condition: conditionText } : {}),
    ...(quantity === undefined ? {} : { quantity }),
    ...(unitPrice === undefined ? {} : { unitPrice }),
    ...(optionalText(row, "comment") ? { comment: optionalText(row, "comment") as string } : {}),
    ...(optionalText(row, "error") ? { error: optionalText(row, "error") as string } : {})
  };
}

/** Сводка по показанным строкам: так она считалась до миграции 0025. */
function inventoryPageSummary(items: readonly InventoryPartRecord[]): InventoryPartPage["summary"] {
  return {
    active: items.filter((item) => item.isActive).length,
    belowMinimum: items.filter((item) => item.belowMinimum).length,
    withEngineers: items.filter((item) => item.withEngineersQuantity > 0).length
  };
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
  id, number, title, status_code, work_type_code, extra_work_type_codes, work_modifier, hours, priority,
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
  id, number, title, status_code, work_type_code, extra_work_type_codes, work_modifier, hours, priority,
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

/** Сколько id за раз уходит в фильтр «in»: длинный список не помещается в адрес запроса. */
const IN_FILTER_CHUNK = 100;

function inChunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/** PostgREST не знает связи между таблицами (схема базы старше приложения). */
function isMissingRelationship(error: { readonly message?: string; readonly code?: string; readonly details?: string; readonly hint?: string } | null): boolean {
  if (!error) return false;
  return /PGRST200|PGRST201|relationship/iu.test([error.code, error.message, error.details, error.hint].filter(Boolean).join(" "));
}

const MAINTENANCE_PLAN_SELECT = "id, equipment_id, plan_year, period_no, period_from, period_to, status, assigned_engineer_id, comment, equipment:equipment(serial_number, manufacturer:manufacturers(name), model:equipment_models(name), site:sites!current_site_id(id, name, organization_id, organization:organizations(name))), engineer:users!assigned_engineer_id(full_name)";
/** Задача, созданная по периоду: связь по составному ключу (период, прибор). */
const MAINTENANCE_PLAN_TASK_EMBED = "generated_task:tasks!task_maintenance_plan_equipment_fk(id)";

/**
 * День момента ISO («2026-11-12») по часам компании (Москва), а не по поясу устройства того,
 * кто смотрит отчёт. Строка без времени возвращается как есть.
 */
export function localDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  return companyDay(value) ?? value.slice(0, 10);
}

/**
 * Массовое назначение инженера: новая задача получает инженера и этап «Назначена»; у запланированной,
 * назначенной и задачи в работе меняется только инженер; сданную, закрытую и отменённую не трогаем.
 */
export function bulkAssignMode(status: string): "assign" | "engineer_only" | "refuse" {
  if (status === "new") return "assign";
  if (status === "planned" || status === "assigned" || status === "in_progress") return "engineer_only";
  return "refuse";
}

/** Закрыта вовремя: день окончания работ (по часам компании) не позже конца срока. Без срока или даты: не считаем. */
export function closedOnTime(completedAt: string | undefined, deadlineTo: string | undefined): boolean | undefined {
  const completed = localDay(completedAt);
  const deadline = deadlineTo?.slice(0, 10);
  if (!completed || !deadline) return undefined;
  return completed <= deadline;
}

/**
 * Границы периода отчёта по часам компании (Москва): с начала первого дня до конца последнего.
 * На любом устройстве одинаково: задача, созданная в 01:00 по Москве, попадает в свой день.
 */
export function reportPeriodBounds(from: string, to: string): { readonly start: string; readonly end: string; readonly endBefore: string } {
  const end = companyDayEnd(to) ?? `${to}T23:59:59.999Z`;
  return {
    start: companyDayStart(from) ?? from,
    end,
    // Начало следующего дня: отбор «меньше этого момента» совпадает с тем, что считает
    // база (0044), а «не позже 23:59:59.999» разошёлся бы с ней на доли миллисекунды —
    // заявка последнего мига дня попала бы в цифры и не попала в выгрузку.
    endBefore: companyDayStart(nextCalendarDay(to)) ?? end
  };
}

/** Следующий календарный день: «2026-11-16» → «2026-11-17». Пусто, если дня нет. */
function nextCalendarDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return day;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Просрочена ли заявка в отчёте за период: открыта и срок вышел к концу периода,
 * но не позже сегодняшнего дня (период может заканчиваться в будущем).
 */
export function reportTaskOverdue(deadlineTo: string | undefined, status: string, periodTo: string, today = companyToday()): boolean {
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
  const isOverdue = Boolean(periodTo && !["closed", "cancelled"].includes(status) && periodTo < companyToday());
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
    ...(Array.isArray(row.extra_work_type_codes) && row.extra_work_type_codes.length
      ? { extraWorkTypeCodes: row.extra_work_type_codes.filter((code): code is string => typeof code === "string") }
      : {}),
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

/** Шапка счёта: к списочным полям добавлены суммы, причина корректировки и даты жизни счёта. */
const INVOICE_CARD_SELECT = "id, number, status, created_at, updated_at, payer_id, subtotal, adjustment_amount, "
  + "total_amount, correction_reason, issued_at, transferred_at, payer:payers!payer_id(id, name, requisites), invoice_tasks(task_id)";

/** Позиция счёта с номером задачи: по нему строки группируются в карточке. */
const INVOICE_ITEM_SELECT = "id, item_type, task_id, description, quantity, unit_price, line_total, modifier, "
  + "excluded_from_total, task:tasks(number, work_finished_at, visit_date, completed_at, updated_at)";

/** История статусов счёта: сначала с автором по связи changed_by → users, затем без него. */
const INVOICE_HISTORY_SELECTS: readonly string[] = [
  "to_status, changed_at, changer:users!changed_by(full_name)",
  "to_status, changed_at"
];

function invoiceItemRecord(row: Row): InvoiceItemApiRecord {
  const modifier = text(row, "modifier");
  const task = related(row, "task");
  return {
    id: text(row, "id"),
    itemType: text(row, "item_type") === "part" ? "part" : "work",
    taskId: optionalText(row, "task_id") ?? null,
    taskNumber: optionalText(related(row, "task"), "number") ?? null,
    description: text(row, "description"),
    quantity: numberValue(row.quantity) ?? 0,
    unitPrice: numberValue(row.unit_price) ?? 0,
    lineTotal: numberValue(row.line_total) ?? 0,
    modifier: modifier === "G" || modifier === "N" ? modifier : null,
    excludedFromTotal: row.excluded_from_total === true,
    workDate: invoiceWorkDate({
      workFinishedAt: optionalText(task, "work_finished_at") ?? null,
      visitDate: optionalText(task, "visit_date") ?? null,
      completedAt: optionalText(task, "completed_at") ?? null,
      updatedAt: optionalText(task, "updated_at") ?? null
    })
  };
}

/**
 * Строка выгрузки: столбцы придумывает база, здесь только приводим значения к тому,
 * что умеет файл. Пустые значения становятся пустой клеткой, а не словом «null».
 */
function invoiceExportRow(row: Row): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === "number" && Number.isFinite(value) ? value : value == null ? "" : String(value);
  }
  return result;
}

export class M2ApiClient {
  public constructor(private readonly client?: AppSupabaseClient) {}

  /** Представления и функция из миграции 0025. Пока их нет в базе, склад и поиск приборов работают как раньше. */
  private inventoryRegistryAvailable = true;
  private inventorySummaryAvailable = true;
  /** Занятость инженеров для подсказки: пока миграции 0051 нет, за ней не ходим каждый раз. */
  private engineerPeriodLoadAvailable = true;
  private equipmentSearchAvailable = true;

  /** Отметка установки и история шагов из миграции 0028: пока их нет, резервы читаются без них. */
  private reservationMarkAvailable = true;
  private reservationHistoryLevel = 0;

  /** Псевдонимы (0047) и остатки по состояниям (0050): пока их нет, склад читается без них. */
  private inventoryExtraColumnsAvailable = true;
  /** Псевдонимы запчасти в поиске резервов (0047): пока таблицы нет в API, резервы читаются без них. */
  private reservationAliasesAvailable = true;

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
    if (error) {
      // Неудачную попытку GoTrue у себя не сохраняет, поэтому её пишем сами (0058).
      // В журнал уходят только набранный адрес и короткий код причины: ни пароля,
      // ни его длины, ни текста ошибки службы входа. Время, адрес обращения и
      // сотрудника подставляет база.
      await this.recordFailedLogin(email, loginFailureReason(error));
      throwIfError(error, "Неверный e-mail или пароль");
    }
    return this.session();
  }

  /** Запись неудачной попытки входа. Сессии у неудачной попытки нет: пишет anon-ключ. */
  private async recordFailedLogin(email: string, reason: string): Promise<void> {
    try {
      await this.db().rpc("record_failed_login", { p_login: email, p_reason: reason });
    } catch {
      // Журнал входов не должен мешать входу: об отказе всё равно скажет сам экран.
    }
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
      // Права своей роли не меняют (миграция 0035): сказать это надо до удаления строк,
      // иначе половина правки уйдёт на сервер и вернётся отказом на середине.
      const session = await this.cachedSession();
      if (key === (session.accessRoleKey ?? session.role)) {
        throw new M2ApiError(400, "Права своей роли менять нельзя: так можно остаться без доступа к системе. Попросите другого администратора");
      }
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
    // Себе вход не отключают и роль себе не меняют (миграция 0035): говорим это до запроса,
    // а не сырой ошибкой базы.
    const session = await this.cachedSession();
    if (input.isActive === false && id === session.id) {
      throw new M2ApiError(400, "Себе вход отключать нельзя: вы сразу потеряете доступ к системе. Попросите другого администратора");
    }
    const patch: Row = {};
    if (input.fullName !== undefined) patch.full_name = input.fullName;
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.accessRoleKey !== undefined) patch.access_role_key = input.accessRoleKey;
    if (id === session.id) {
      const roleChanged = (patch.access_role_key !== undefined && patch.access_role_key !== session.accessRoleKey)
        || (patch.role !== undefined && patch.role !== session.role);
      if (roleChanged) {
        throw new M2ApiError(400, "Себе роль менять нельзя: так можно остаться без нужных прав. Попросите другого администратора");
      }
      // Неизменившуюся роль не отправляем вовсе: база сторожит сам факт правки этих полей.
      delete patch.access_role_key;
      delete patch.role;
    }
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
    // Инженеру, кладовщику и инициатору положены только свои уведомления (миграция 0034).
    // Правило держит база, запрос его повторяет: иначе счётчик «N из N» считал бы чужие строки.
    const session = await this.cachedSession();
    const ownOnly = !canReadWholeNotificationJournal(session.permissions);
    let request = this.db().from("notifications").select("id, event_code, recipient_user_id, channel, recipient_address, subject, body, status, scheduled_at, sent_at, delivered_at, attempts, last_error, task_id, created_at", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (ownOnly) request = request.eq("recipient_user_id", session.id);
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
      offset,
      ownOnly
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

  /**
   * Журнал изменений (ТЗ 6.3). Читается из представления audit_log_journal (0057):
   * доступ решает правило строк audit_log по праву «Просмотр аудита», отбор, счёт
   * и порядок делает база — на стенде записей десятки тысяч.
   */
  public async auditJournal(query: {
    readonly actorId?: string;
    readonly entityType?: string;
    readonly search?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<AuditJournalPage> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    let request = this.db().from("audit_log_journal")
      .select(AUDIT_JOURNAL_SELECT, { count: "exact" })
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.actorId) request = request.eq("actor_user_id", query.actorId);
    if (query.entityType) request = request.eq("entity_type", query.entityType);
    if (query.from) request = request.gte("occurred_at", companyDayStart(query.from) ?? query.from);
    if (query.to) request = request.lte("occurred_at", companyDayEnd(query.to) ?? query.to);
    // Поиск по номеру объекта, действию, таблице и автору: всё это столбцы, отбор в базе.
    const search = escapePostgrestSearchTerm(query.search ?? "");
    if (search) {
      // В журнале действия лежат кодами (updated), а на экране написано «Изменено»:
      // ищем и по коду, и по тому слову, которое человек видит в списке.
      const actionCodes = auditActionCodesForSearch(query.search ?? "");
      request = request.or([
        `entity_id.ilike.*${search}*`,
        `action.ilike.*${search}*`,
        ...(actionCodes.length > 0 ? [`action.in.(${actionCodes.join(",")})`] : []),
        `table_name.ilike.*${search}*`,
        `actor_name.ilike.*${search}*`
      ].join(","));
    }
    const { data, error, count } = await request;
    throwIfError(error, "Не получилось загрузить журнал изменений");
    return {
      items: (data ?? []).map((item) => {
        const row = asRow(item);
        return {
          id: numberValue(row.id) ?? 0,
          occurredAt: iso(row.occurred_at),
          actorType: text(row, "actor_type"),
          ...(optionalText(row, "actor_user_id") ? { actorUserId: optionalText(row, "actor_user_id") } : {}),
          ...(optionalText(row, "actor_name") ? { actorName: optionalText(row, "actor_name") } : {}),
          action: text(row, "action"),
          outcome: text(row, "outcome"),
          entityType: text(row, "entity_type"),
          entityId: text(row, "entity_id"),
          ...(optionalText(row, "table_name") ? { tableName: optionalText(row, "table_name") } : {}),
          changedFields: Array.isArray(row.changed_fields) ? row.changed_fields.map((field) => String(field)) : [],
          ...(row.before_data ? { beforeData: asRow(row.before_data) } : {}),
          ...(row.after_data ? { afterData: asRow(row.after_data) } : {}),
          ...(row.metadata ? { metadata: asRow(row.metadata) } : {}),
          moneyHidden: row.money_hidden === true,
          ...(optionalText(row, "ip_address") ? { ipAddress: optionalText(row, "ip_address") } : {})
        };
      }),
      total: count ?? 0,
      limit,
      offset
    };
  }

  /**
   * Журнал входов (ТЗ 6.3). Удачные входы лежат в журнале службы входа (схема auth),
   * поэтому страницу собирает функция login_journal (0058): она же проверяет право
   * «Просмотр аудита» и считает всё в базе.
   */
  public async loginJournal(query: {
    readonly userId?: string;
    readonly outcome?: "success" | "failure";
    readonly search?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<LoginJournalPage> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const { data, error } = await this.db().rpc("login_journal", {
      p_user_id: query.userId ?? null,
      p_outcome: query.outcome ?? null,
      p_search: query.search?.trim() || null,
      p_from: query.from ? companyDayStart(query.from) ?? query.from : null,
      p_to: query.to ? companyDayEnd(query.to) ?? query.to : null,
      p_limit: limit,
      p_offset: offset
    });
    throwIfError(error, "Не получилось загрузить журнал входов");
    const page = asRow(data);
    const items = Array.isArray(page.items) ? page.items : [];
    return {
      items: items.map((item) => {
        const row = asRow(item);
        return {
          id: text(row, "id"),
          source: text(row, "source") === "gotrue" ? "gotrue" : "app",
          occurredAt: iso(row.occurredAt),
          ...(optionalText(row, "userId") ? { userId: optionalText(row, "userId") } : {}),
          ...(optionalText(row, "userName") ? { userName: optionalText(row, "userName") } : {}),
          ...(optionalText(row, "login") ? { login: optionalText(row, "login") } : {}),
          ...(optionalText(row, "ipAddress") ? { ipAddress: optionalText(row, "ipAddress") } : {}),
          success: row.success === true,
          ...(optionalText(row, "failureReason") ? { failureReason: optionalText(row, "failureReason") } : {})
        };
      }),
      total: numberValue(page.total) ?? 0,
      limit,
      offset,
      successSourceAvailable: page.successSourceAvailable === true
    };
  }

  /** Сотрудники для фильтра «кто» в журналах: имена видит любой сотрудник CRM. */
  public async journalPeople(): Promise<readonly { readonly id: string; readonly fullName: string }[]> {
    const { data, error } = await this.db().from("users").select("id, full_name").order("full_name");
    throwIfError(error, "Не получилось загрузить список сотрудников");
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return { id: text(row, "id"), fullName: text(row, "full_name") };
    });
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
    let siteId: string | undefined;
    let payerId: string | undefined;
    let manufacturerId: string | undefined;
    if (query.site) {
      siteId = await this.resolveFilterId("sites", query.site);
      if (!siteId) return paged([], 0, limit, offset);
    }
    if (query.payer) {
      payerId = await this.resolveFilterId("payers", query.payer);
      if (!payerId) return paged([], 0, limit, offset);
    }
    if (query.manufacturer) {
      manufacturerId = await this.resolveFilterId("manufacturers", query.manufacturer);
      if (!manufacturerId) return paged([], 0, limit, offset);
    }
    const pageRequest = (source: "equipment" | "equipment_search") => {
      let request = this.db().from(source).select(EQUIPMENT_SELECT, { count: "exact" }).order("serial_number").range(offset, offset + limit - 1);
      if (query.status) request = request.eq("status_code", query.status);
      if (siteId) request = request.eq("current_site_id", siteId);
      if (payerId) request = request.eq("current_payer_id", payerId);
      if (manufacturerId) request = request.eq("manufacturer_id", manufacturerId);
      return request;
    };
    const tokens = searchTokens(query.search);
    let response: Awaited<ReturnType<typeof pageRequest>> | undefined;
    if (tokens.length > 0 && this.equipmentSearchAvailable) {
      // Поиск по S/N, модели, производителю, площадке, организации, плательщику и примечанию
      // в базе (представление equipment_search, миграция 0025): каждое слово должно найтись.
      // Строки, связи и права те же, что у таблицы equipment.
      let request = pageRequest("equipment_search");
      for (const token of tokens) request = request.ilike("search_text", searchTextPattern(token));
      response = await request;
      if (isMissingSchemaObject(response.error, "equipment_search")) {
        this.equipmentSearchAvailable = false;
        response = undefined;
      }
    }
    if (!response) {
      // Без миграции 0025 ищем, как раньше, по S/N и примечанию.
      let request = pageRequest("equipment");
      const term = tokens.length > 0 ? escapePostgrestSearchTerm(query.search ?? "") : "";
      if (term) request = request.or([`serial_number.ilike.%${term}%`, `notes.ilike.%${term}%`].join(","));
      response = await request;
    }
    const { data, error, count } = response;
    // Старый Select мог прислать подпись вместо uuid — не роняем список, показываем пусто.
    if (error && /invalid input syntax for type uuid|22P02/iu.test(error.message)) {
      return paged([], 0, limit, offset);
    }
    throwIfError(error);
    return paged((data ?? []).map((item) => mapEquipment(asRow(item))), count ?? 0, limit, offset);
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
      const part = historyPartDetails(details);
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
        ...(part ? { part } : {}),
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

  /**
   * Все строки справочника: читаем общим постраничным помощником, которым уже
   * читаются планы ТО и задачи. PostgREST отдаёт не больше max_rows за запрос,
   * а обрезанный справочник сказал бы «модели нет» там, где она есть.
   */
  private async readAllRows(
    table: string, columns: string, failure: string, activeOnly = false
  ): Promise<readonly Row[]> {
    const rows = await allPages((start, end, withCount) => {
      const request = this.db().from(table)
        .select(columns, withCount ? { count: "exact" } : undefined);
      // Порядок с id вторым ключом: у площадок имена повторяются у разных организаций.
      return (activeOnly ? request.eq("is_active", true) : request)
        .order("name").order("id").range(start, end);
    }, failure);
    return rows.map(asRow);
  }

  /**
   * Снимок базы для пробного импорта (экран «Импорт»): справочник моделей,
   * названия площадок и плательщиков, приборы по серийным номерам из файла и
   * уже записанные ключи их истории. Только чтение: ничего не меняет.
   */
  public async importSnapshot(serialNumbers: readonly string[]): Promise<ImportSnapshot> {
    const keys = [...new Set(serialNumbers.map(importSerialKey).filter(Boolean))];
    // Справочники читаем страницами: PostgREST отдаёт не больше max_rows (1000),
    // а обрезанный справочник показал бы «модели нет» там, где она есть.
    const [manufacturers, models, sites, payers] = await Promise.all([
      // Скрытые записи справочника тоже нужны: название в них уже занято.
      this.readAllRows("manufacturers", "id, name, is_active", "Не получилось прочитать справочник производителей"),
      this.readAllRows("equipment_models", "id, name, manufacturer_id, is_active", "Не получилось прочитать справочник моделей"),
      this.readAllRows("sites", "name", "Не получилось прочитать список площадок", true),
      this.readAllRows("payers", "name", "Не получилось прочитать список плательщиков", true)
    ]);
    const manufacturerById = new Map(manufacturers
      .map((item) => [text(item, "id"), {
        name: text(item, "name"),
        isActive: item.is_active !== false
      }]));

    const equipment: ImportExistingEquipment[] = [];
    // Серийные номера передаём порциями: в условии in.() их может быть много.
    for (let offset = 0; offset < keys.length; offset += 100) {
      const { data, error } = await this.db()
        .from("equipment")
        .select("id, serial_number, manufacturer:manufacturers(name), model:equipment_models(name)")
        .in("serial_number_normalized", keys.slice(offset, offset + 100));
      throwIfError(error);
      for (const item of data ?? []) {
        const row = asRow(item);
        equipment.push({
          id: text(row, "id"),
          serialNumber: text(row, "serial_number"),
          modelName: text(related(row, "model"), "name"),
          manufacturerName: text(related(row, "manufacturer"), "name")
        });
      }
    }

    const historyKeys: string[] = [];
    const ids = equipment.map((item) => item.id);
    const PAGE = 500;
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      // Страницами: иначе у приборов с длинной историей часть ключей осталась бы
      // за пределом ответа и пробный импорт обещал бы уже записанные события.
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await this.db()
          .from("equipment_history")
          .select("source_key")
          .in("equipment_id", batch)
          .not("source_key", "is", null)
          .order("source_key")
          .range(from, from + PAGE - 1);
        throwIfError(error);
        for (const item of data ?? []) historyKeys.push(text(asRow(item), "source_key"));
        if ((data ?? []).length < PAGE) break;
      }
    }

    return {
      manufacturers: [...manufacturerById.values()],
      models: models.map((row) => {
        const manufacturerId = text(row, "manufacturer_id");
        const maker = manufacturerById.get(manufacturerId);
        return {
          id: text(row, "id"),
          name: text(row, "name"),
          manufacturerId,
          manufacturerName: maker?.name ?? "",
          // Скрытый производитель делает скрытой и свою модель: прибор на неё не завести.
          isActive: row.is_active !== false && maker?.isActive !== false
        };
      }),
      sites: sites.map((row) => text(row, "name")),
      payers: payers.map((row) => text(row, "name")),
      equipment,
      historyKeys
    };
  }

  /**
   * Запись подтверждённого импорта: одна транзакция в базе (функция 0054).
   * Существующие приборы не переписывает, повтор того же файла ничего не добавляет.
   */
  public async applyEquipmentImport(
    sourceName: string,
    write: { readonly equipment: readonly ImportWriteEquipment[]; readonly events: readonly ImportWriteEvent[] }
  ): Promise<ImportWriteResult> {
    const { data, error } = await this.db().rpc("import_equipment_history", {
      p_source_name: sourceName,
      p_equipment: write.equipment,
      p_events: write.events
    });
    throwIfError(error, "Не получилось записать импорт");
    const row = asRow(data);
    const count = (key: string): number => numberValue(row[key]) ?? 0;
    return {
      sourceName: text(row, "sourceName") || sourceName,
      manufacturersCreated: count("manufacturersCreated"),
      modelsCreated: count("modelsCreated"),
      equipmentCreated: count("equipmentCreated"),
      equipmentAlready: count("equipmentAlready"),
      eventsCreated: count("eventsCreated"),
      eventsAlready: count("eventsAlready"),
      eventsWithoutEquipment: count("eventsWithoutEquipment")
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
    // Реквизиты проверяет база (миграция 0036), здесь — чтобы отказ пришёл до запроса.
    assertRequisites({ ...(inn ? { inn } : {}), ...(kpp ? { kpp } : {}) });
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
      // Здесь не проверяем: база (миграция 0036) пропускает старую запись с мусором,
      // пока реквизиты не трогают, а отсюда прежних значений не видно. Проверяет экран,
      // где известно, что человек изменил, — иначе правка ФИО упиралась бы в чужую опечатку.
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
    /** Гарантия: «G» гарантийные, «N» вина клиента, «none» без отметки. */
    readonly guarantee?: "G" | "N" | "none";
    /**
     * По дню создания по Москве, включительно — так заявки отбирает отчёт (0044).
     * Нужен переходу из отчёта: фильтр «Период» смотрит на срок, а не на создание.
     */
    readonly createdFrom?: string;
    readonly createdTo?: string;
    /** Причина обращения; «none» — причина не указана. */
    readonly reasonCode?: string;
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
      is: (column: string, value: null) => T;
    }>(request: T): T => {
      let next = request;
      // Период: задачи, срок которых пересекается с выбранным периодом.
      if (query.periodFrom) next = next.gte("deadline_to", query.periodFrom.slice(0, 10));
      if (query.periodTo) next = next.lte("deadline_from", query.periodTo.slice(0, 10));
      if (query.overdue) {
        next = next.lt("deadline_to", companyToday()).not("status_code", "in", "(closed,cancelled)");
      }
      if (query.status) next = next.eq("status_code", query.status);
      if (query.engineerId === "none") next = next.is("engineer_id", null);
      else if (query.engineerId) next = next.eq("engineer_id", query.engineerId);
      if (query.equipmentId) next = next.eq("equipment_id", query.equipmentId);
      if (query.openOnly) next = next.not("status_code", "in", "(closed,cancelled)");
      if (query.siteId) next = next.eq("site_id", query.siteId);
      // Вид работ — основной или дополнительный (0060).
      if (query.workTypeCode) next = next.or(`work_type_code.eq.${query.workTypeCode},extra_work_type_codes.cs.{${query.workTypeCode}}`);
      if (query.priority) next = next.eq("priority", query.priority);
      if (query.guarantee === "none") next = next.is("work_modifier", null);
      else if (query.guarantee) next = next.eq("work_modifier", query.guarantee);
      if (query.reasonCode === "none") next = next.is("reason_code", null);
      else if (query.reasonCode) next = next.eq("reason_code", query.reasonCode);
      const createdFrom = query.createdFrom ? companyDayStart(query.createdFrom) : undefined;
      const createdTo = query.createdTo ? companyDayEnd(query.createdTo) : undefined;
      if (createdFrom) next = next.gte("created_at", createdFrom);
      if (createdTo) next = next.lte("created_at", createdTo);
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
   * Письмо и вложения становятся файлами задачи: их открывает и скачивает каждый,
   * кому доступна задача (права на объект письма в хранилище даёт та же строка files).
   * Переносит база одной функцией (0041), поэтому половины файлов не бывает.
   * Возвращает число файлов, которые не получилось перенести.
   */
  public async attachMailToTask(mail: MailInboxRecord, taskId: string): Promise<number> {
    const expected = (mail.rawStorageKey ? 1 : 0) + (mail.attachments?.length ?? 0);
    const { data, error } = await this.db().rpc("attach_mail_files_to_task", { p_mail_id: mail.id, p_task_id: taskId });
    throwIfError(error, "Не получилось приложить письмо к задаче");
    const linked = typeof data === "number" ? data : 0;
    return Math.max(0, expected - linked);
  }

  /** Вся переписка по задаче для карточки: письма клиента и наши ответы по порядку. */
  public async taskMailThread(taskId: string): Promise<readonly TaskMailMessage[]> {
    const { data, error } = await this.db().rpc("task_mail_thread", { p_task_id: taskId });
    throwIfError(error, "Не получилось загрузить переписку по задаче");
    return (data as unknown[] ?? []).map((item) => {
      const row = asRow(item);
      const attachments = Array.isArray(row.attachments)
        ? row.attachments.map((entry) => asRow(entry)).map((entry): TaskMailAttachment => ({
            fileName: typeof entry.fileName === "string" && entry.fileName ? entry.fileName : "вложение",
            contentType: typeof entry.contentType === "string" ? entry.contentType : "application/octet-stream",
            byteSize: numberValue(entry.byteSize) ?? 0,
            ...(typeof entry.fileId === "string" ? { fileId: entry.fileId } : {}),
            ...(typeof entry.storageKey === "string" ? { storageKey: entry.storageKey } : {})
          }))
        : [];
      return {
        id: text(row, "id"),
        direction: text(row, "direction") === "outgoing" ? "outgoing" : "incoming",
        author: text(row, "author"),
        subject: text(row, "subject"),
        body: text(row, "body"),
        occurredAt: iso(row.occurred_at),
        status: text(row, "status"),
        ...(optionalText(row, "recipient") ? { recipient: text(row, "recipient") } : {}),
        ...(optionalText(row, "error") ? { error: text(row, "error") } : {}),
        attachments
      };
    });
  }

  /** Можно ли отвечать клиенту по этой задаче: решает база, экран лишь повторяет. */
  public async canReplyTaskMail(taskId: string): Promise<boolean> {
    const { data, error } = await this.db().rpc("app_can_reply_task_mail", { p_task_id: taskId });
    throwIfError(error);
    return data === true;
  }

  /** Ответ координатора клиенту: база ставит его в очередь, служба отправляет в той же цепочке. */
  public async sendTaskMailReply(taskId: string, body: string): Promise<void> {
    const refusal = taskMailReplyRefusal(body);
    if (refusal) throw new M2ApiError(422, refusal);
    const { error } = await this.db().rpc("send_task_mail_reply", { p_task_id: taskId, p_body: body.trim() });
    throwIfError(error, "Не получилось отправить ответ клиенту");
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
        ...(task.workModifier ? { workModifier: task.workModifier } : {}),
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
    return this.loadTask(await this.insertTask(input));
  }

  /** Вставка задачи без чтения карточки: id новой задачи. */
  private async insertTask(input: Readonly<Record<string, unknown>>): Promise<string> {
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
    // Задача из плана ТО создаётся «Запланированной»: новой её сделает запуск по расписанию
    // (activate_due_maintenance_tasks) к началу периода. Остальные задачи создаются новыми.
    const planned = input.isMaintenancePlan === true && input.statusCode === "planned";
    const payload = {
      title: input.title,
      work_type_code: String(input.workTypeCode || "diagnostics"),
      ...(Array.isArray(input.extraWorkTypeCodes) && input.extraWorkTypeCodes.length
        ? { extra_work_type_codes: input.extraWorkTypeCodes }
        : {}),
      ...(planned ? { status_code: "planned" } : {}),
      priority: input.priority ?? "planned",
      ...(input.workModifier === "G" || input.workModifier === "N" ? { work_modifier: input.workModifier } : {}),
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
      call_date: input.callDate ?? companyToday(),
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
    return text(asRow(data), "id");
  }

  public async updateTaskOverview(id: string, input: {
    readonly title: string;
    readonly workTypeCode: string;
    readonly priority: "urgent" | "planned";
    /** Г — гарантийный случай, Н — вина клиента, null — не гарантия. Ставит координатор. */
    readonly workModifier?: "G" | "N" | null;
    /** Дополнительные виды работ; пустой список — только основной. */
    readonly extraWorkTypeCodes?: readonly string[];
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly callDate: string;
    readonly visitDate?: string;
    /** Время работ, перенесённое на новую дату выезда (только если дату сменили). */
    readonly workStartedAt?: string;
    readonly workFinishedAt?: string;
  }): Promise<TaskApiRecord> {
    const { error } = await this.db().from("tasks").update({
      title: input.title,
      work_type_code: input.workTypeCode,
      priority: input.priority,
      ...(input.workModifier !== undefined ? { work_modifier: input.workModifier } : {}),
      ...(input.extraWorkTypeCodes !== undefined ? { extra_work_type_codes: input.extraWorkTypeCodes } : {}),
      deadline_from: input.periodFrom,
      deadline_to: input.periodTo,
      call_date: input.callDate,
      visit_date: input.visitDate ?? null,
      ...(input.workStartedAt ? { work_started_at: input.workStartedAt } : {}),
      ...(input.workFinishedAt ? { work_finished_at: input.workFinishedAt } : {})
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
    /** Дата выезда (календарная дата) и время начала и окончания работ из акта. */
    readonly visitDate?: string | null;
    readonly workStartedAt?: string | null;
    readonly workFinishedAt?: string | null;
  }): Promise<TaskCardResponse> {
    const { error } = await this.db().from("tasks").update({
      ...(input.visitDate !== undefined ? { visit_date: input.visitDate } : {}),
      ...(input.workStartedAt !== undefined ? { work_started_at: input.workStartedAt } : {}),
      ...(input.workFinishedAt !== undefined ? { work_finished_at: input.workFinishedAt } : {}),
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
    const data = await this.maintenancePlanRows(year, filters);
    const items: MaintenancePlanPeriodResponse[] = data.map((item) => {
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
        generatedTaskId: optionalText(related(row, "generated_task"), "id"),
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

  /**
   * Все периоды года, а не первые 1000 (столько сервер отдаёт за раз), вместе с задачей,
   * созданной по периоду. Если база не знает связи с задачами, план читается без них.
   */
  private async maintenancePlanRows(
    year: number,
    filters: { readonly equipmentId?: string; readonly engineerId?: string }
  ): Promise<unknown[]> {
    let relationMissing = false;
    const load = (select: string) => allPages((start, end, withCount) => {
      let request = this.db().from("maintenance_plans")
        .select(select, withCount ? { count: "exact" } : undefined)
        .eq("plan_year", year);
      if (filters.equipmentId) request = request.eq("equipment_id", filters.equipmentId);
      if (filters.engineerId) request = request.eq("assigned_engineer_id", filters.engineerId);
      return request.order("period_from").order("id").range(start, end).then((response) => {
        if (isMissingRelationship(response.error)) relationMissing = true;
        return response;
      });
    }, "Не получилось загрузить план ТО");
    try {
      return await load(`${MAINTENANCE_PLAN_SELECT}, ${MAINTENANCE_PLAN_TASK_EMBED}`);
    } catch (error) {
      if (!relationMissing) throw error;
      return load(MAINTENANCE_PLAN_SELECT);
    }
  }

  /**
   * Годовой план прибора сохраняется одной транзакцией (функция базы, миграция 0026): если новый
   * период не сохранится, старые останутся. Периоды с задачей и закрытые база не меняет (их даты
   * должны прийти без изменений), свободные с теми же датами меняет на месте, остальные заменяет.
   * Номер ТО на экране — порядок дат, period_no в базе — только место периода.
   */
  public async replaceMaintenancePlan(input: ReplaceAnnualMaintenancePlanRequest): Promise<{
    readonly year: number;
    readonly items: MaintenancePlanListResponse["items"];
  }> {
    assertAnnualMaintenancePlan(input);
    const periods = [...input.periods].sort((left, right) => left.periodFrom.localeCompare(right.periodFrom) || left.periodTo.localeCompare(right.periodTo));
    const { error } = await this.db().rpc("replace_maintenance_plan", {
      p_equipment_id: input.equipmentId,
      p_year: input.year,
      p_periods: periods.map((period) => ({
        periodFrom: period.periodFrom,
        periodTo: period.periodTo,
        assignedEngineerId: period.assignedEngineerId || null,
        comment: period.comment?.trim() || null
      }))
    });
    if (error && (error as { readonly code?: string }).code === "PGRST202") {
      await this.replaceMaintenancePlanInSteps(input.equipmentId, input.year, periods);
    } else {
      throwIfError(error, "Не получилось сохранить план");
    }
    const list = await this.maintenancePlans(input.year, "equipment", { equipmentId: input.equipmentId });
    return { year: input.year, items: list.items };
  }

  /** Пока в базе нет функции из 0026: как раньше, удаление и вставка отдельными запросами. */
  private async replaceMaintenancePlanInSteps(
    equipmentId: string,
    year: number,
    periods: ReplaceAnnualMaintenancePlanRequest["periods"]
  ): Promise<void> {
    const actor = await this.actorId();
    const { error: deleteError } = await this.db().from("maintenance_plans").delete().eq("equipment_id", equipmentId).eq("plan_year", year);
    throwIfError(deleteError, "Не получилось сохранить план");
    const rows = periods.map((period, index) => ({
      equipment_id: equipmentId,
      plan_year: year,
      period_no: index + 1,
      period_from: period.periodFrom,
      period_to: period.periodTo,
      work_type_code: "maintenance",
      assigned_engineer_id: period.assignedEngineerId || null,
      comment: period.comment?.trim() || null,
      created_by: actor
    }));
    const { error } = await this.db().from("maintenance_plans").insert(rows);
    throwIfError(error, "Не получилось сохранить план");
  }

  /**
   * Задачи по запланированным периодам года: «Запланированные», с инженером из плана, если он
   * указан. Новыми их делает запуск по расписанию к началу периода. Повторный запуск задач не
   * дублирует: у периода задача одна (tasks_maintenance_plan_once_uq).
   */
  public async generateMaintenanceTasks(year: number, planIds?: readonly string[]): Promise<GenerateMaintenanceTasksResponse> {
    const actor = await this.actorId();
    const rows = await this.plannedMaintenanceRows(year, planIds);
    const created: Array<{ readonly planId: string; readonly taskId: string }> = [];
    const existing: Array<{ readonly planId: string; readonly taskId: string }> = [];
    const failures: Array<{ readonly planId: string; readonly code: "invalid_status" | "missing_relation" | "not_found"; readonly error: string }> = [];
    for (const chunk of inChunks(rows, IN_FILTER_CHUNK)) {
      // Уже созданные задачи этих периодов одним запросом, а не по запросу на период.
      const ids = chunk.map((item) => text(asRow(item), "id"));
      const { data: tasks, error: tasksError } = await this.db().from("tasks").select("id, maintenance_plan_id").in("maintenance_plan_id", ids);
      throwIfError(tasksError, "Не получилось проверить задачи плана");
      const taskByPlan = new Map((tasks ?? []).map((item) => [text(asRow(item), "maintenance_plan_id"), text(asRow(item), "id")]));
      for (const item of chunk) {
        const row = asRow(item);
        const planId = text(row, "id");
        const existingTaskId = taskByPlan.get(planId);
        if (existingTaskId) {
          // Задача уже есть, а период всё ещё «Запланирован» (прошлый запуск прервался): отмечаем.
          existing.push({ planId, taskId: existingTaskId });
          await this.markMaintenancePeriodGenerated(planId, actor);
          continue;
        }
        let taskId: string;
        try {
          // Только вставка, без чтения карточки: ошибка чтения не выдала бы созданную задачу за неудачу.
          taskId = await this.insertTask({
            title: `ТО ${year}`,
            workTypeCode: "maintenance",
            statusCode: "planned",
            isMaintenancePlan: true,
            maintenancePlanId: planId,
            equipmentId: text(row, "equipment_id"),
            engineerId: optionalText(row, "assigned_engineer_id"),
            periodFrom: text(row, "period_from"),
            periodTo: text(row, "period_to")
          });
        } catch (caught) {
          // Задачу по периоду мог только что создать другой координатор: тогда она «уже была».
          const { data: raced } = await this.db().from("tasks").select("id").eq("maintenance_plan_id", planId).maybeSingle();
          if (raced) {
            existing.push({ planId, taskId: text(asRow(raced), "id") });
            await this.markMaintenancePeriodGenerated(planId, actor);
            continue;
          }
          failures.push({ planId, code: "invalid_status", error: caught instanceof Error ? caught.message : "Не удалось создать задачу" });
          continue;
        }
        // Задача создана: она и считается, даже если отметка периода не запишется
        // (её поставит следующий запуск, задача второй раз не создастся).
        created.push({ planId, taskId });
        await this.markMaintenancePeriodGenerated(planId, actor);
      }
    }
    return { requestedCount: rows.length, created, existing, failures };
  }

  /** Запланированные периоды года: все или выбранные (id частями, чтобы адрес запроса не вырос). */
  private async plannedMaintenanceRows(year: number, planIds?: readonly string[]): Promise<unknown[]> {
    const select = "id, equipment_id, period_from, period_to, assigned_engineer_id, status";
    if (!planIds?.length) {
      return allPages((start, end, withCount) => this.db().from("maintenance_plans")
        .select(select, withCount ? { count: "exact" } : undefined)
        .eq("plan_year", year).eq("status", "planned")
        .order("period_from").order("id")
        .range(start, end), "Не получилось загрузить план ТО");
    }
    const rows: unknown[] = [];
    for (const ids of inChunks([...new Set(planIds)], IN_FILTER_CHUNK)) {
      const { data, error } = await this.db().from("maintenance_plans").select(select)
        .eq("plan_year", year).eq("status", "planned").in("id", ids)
        .order("period_from").order("id");
      throwIfError(error, "Не получилось загрузить план ТО");
      rows.push(...(data ?? []));
    }
    return rows;
  }

  /**
   * Период отмечается «Задача создана», только если он ещё «Запланирован». Ошибку не поднимаем:
   * задача уже есть и видна в плане, отметку поставит следующий запуск (задача не задвоится).
   */
  private async markMaintenancePeriodGenerated(planId: string, actor: string): Promise<void> {
    try {
      await this.db().from("maintenance_plans").update({
        status: "generated",
        generated_at: new Date().toISOString(),
        generated_by: actor
      }).eq("id", planId).eq("status", "planned");
    } catch {
      // Сеть оборвалась: отметку поставит следующий запуск.
    }
  }

  public async taskCard(id: string): Promise<TaskCardResponse> {
    // Шаг 1: всё, что зависит только от id задачи, одновременно.
    // Столбец reservation_id появился в 0028, for_sale раньше: если их в базе ещё нет,
    // читаем запчасти по-старому, а не роняем карточку. Сколько штук и из какого резерва
    // встало на прибор, строка task_parts не говорит: это знают сами резервы.
    const loadParts = async (): Promise<{ data: unknown[] | null; error: { message?: string } | null }> => {
      const selects = [
        `${TASK_PART_SELECT}, for_sale, reservation_id`,
        `${TASK_PART_SELECT}, for_sale`,
        TASK_PART_SELECT
      ];
      for (const [index, select] of selects.entries()) {
        const result = await this.db().from("task_parts").select(select).eq("task_id", id).order("position");
        if (!result.error || index === selects.length - 1) return result;
        if (!/for_sale|reservation_id/iu.test(result.error.message ?? "")) return result;
      }
      return { data: null, error: null };
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
        const reservationId = optionalText(row, "reservation_id");
        return {
          id: text(row, "id"),
          articleNumber: text(row, "article_number_snapshot"),
          name: text(row, "name_snapshot"),
          quantity: numberValue(row.quantity) ?? 0,
          condition: text(row, "part_condition") as TaskPartPosition["condition"],
          ...(row.for_sale === true ? { forSale: true } : {}),
          ...(reservationId ? { reservationId } : {})
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

  /**
   * Список запчастей задачи, которые ведут руками. Позиции из резерва склада (reservation_id)
   * не трогаем: их создаёт и закрывает склад, а инженер только отмечает установку.
   */
  public async replaceTaskParts(id: string, items: readonly Omit<TaskPartPosition, "id">[]): Promise<TaskPartsResponse> {
    const linked = await this.linkedTaskParts(id);
    const deleteRequest = this.db().from("task_parts").delete().eq("task_id", id);
    const { error: deleteError } = await (linked.supported ? deleteRequest.is("reservation_id", null) : deleteRequest);
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
          // Позиции из резерва остаются на своих местах, ручные идут после них.
          position: linked.nextPosition + index
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

  /**
   * Строки запчастей задачи, привязанные к резерву склада. Пока столбца reservation_id
   * в базе нет (до миграции 0028), считаем, что таких строк нет, и работаем как раньше.
   */
  private async linkedTaskParts(taskId: string): Promise<{ readonly supported: boolean; readonly nextPosition: number }> {
    const { data, error } = await this.db().from("task_parts").select("position").eq("task_id", taskId).not("reservation_id", "is", null);
    if (error) {
      if (/reservation_id/iu.test(error.message ?? "")) return { supported: false, nextPosition: 0 };
      throwIfError(error, "Не получилось прочитать запчасти задачи");
    }
    const positions = (data ?? []).map((item) => numberValue(asRow(item).position) ?? 0);
    return { supported: true, nextPosition: positions.length ? Math.max(...positions) + 1 : 0 };
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
      this.db().from("users").select("id, full_name, is_active, engineer_competencies(id, manufacturer_id, model_line, manufacturer:manufacturers(name))").eq("role", "engineer").order("full_name"),
      allPages((start, end, withCount) => this.db().from("tasks")
        .select("id, engineer_id, status_code, deadline_to", withCount ? { count: "exact" } : undefined)
        .not("engineer_id", "is", null).not("status_code", "in", "(closed,cancelled)")
        .order("id", { ascending: true })
        .range(start, end), "Не получилось загрузить задачи инженеров")
    ]);
    throwIfError(error);
    const engineers = data ?? [];
    const today = companyToday();
    return engineers.map((item) => {
      const row = asRow(item);
      const id = text(row, "id");
      const assigned = (tasks ?? []).filter((task) => text(asRow(task), "engineer_id") === id);
      const competencies = Array.isArray(row.engineer_competencies) ? row.engineer_competencies : [];
      return {
        id,
        fullName: text(row, "full_name"),
        isActive: row.is_active !== false,
        competencies: sortCompetencies(competencies.map((competency) => {
          const value = asRow(competency);
          return {
            id: optionalText(value, "id"),
            manufacturerId: optionalText(value, "manufacturer_id"),
            manufacturer: optionalText(related(value, "manufacturer"), "name"),
            modelLine: optionalText(value, "model_line")
          };
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

  /**
   * Карточка инженера: имя, активность и набор компетенций. Набор заменяется целиком функцией
   * базы (миграция 0026) в одной транзакции: убранные удаляются, новые добавляются, при ошибке
   * набор не меняется. Компетенции сохраняются первыми, имя — вторым запросом: если функции
   * в базе ещё нет или набор не прошёл проверку, не меняется ничего; если после набора не
   * сохранилось имя, окно покажет ошибку, и повтор запишет только имя.
   */
  public async updateEngineer(id: string, input: Readonly<Record<string, unknown>>): Promise<EngineerOverview> {
    if (Array.isArray(input.competencies)) {
      let competencies: ReturnType<typeof competencyPayload>;
      try {
        competencies = competencyPayload(input.competencies as readonly EngineerCompetency[]);
      } catch (invalid) {
        throw new M2ApiError(400, invalid instanceof Error ? invalid.message : "Проверьте компетенции");
      }
      const { error } = await this.db().rpc("replace_engineer_competencies", { p_engineer_id: id, p_competencies: competencies });
      if (error && (error as { readonly code?: string }).code === "PGRST202") {
        throw new M2ApiError(501, "Компетенции заработают после обновления базы на сервере. Карточка пока не сохранена");
      }
      throwIfError(error, "Не получилось сохранить компетенции");
    }
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
    // Выбору запчасти в задаче сводка склада не нужна.
    return (await this.inventoryPartRows(includeInactive ? {} : { state: "active" }, 500, 0)).items;
  }

  /**
   * Страница склада. Фильтр, поиск, сортировку и общее число считает база по представлению
   * inventory_part_registry, карточки над списком — функция inventory_part_summary() по всему
   * складу, а не по странице (миграция 0025).
   */
  public async inventoryPartPage(query: { readonly search?: string; readonly state?: string; readonly stock?: string; readonly sort?: string; readonly limit?: number; readonly offset?: number } = {}): Promise<InventoryPartPage> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const [{ items, total }, summary] = await Promise.all([
      this.inventoryPartRows(query, limit, offset),
      this.inventoryPartSummary()
    ]);
    const hasMore = offset + items.length < total;
    return {
      items,
      total,
      limit,
      offset,
      hasMore,
      nextOffset: hasMore ? offset + items.length : undefined,
      summary: summary ?? inventoryPageSummary(items)
    };
  }

  /**
   * Строки склада по состоянию (active, low — активные ниже минимума, inactive, all),
   * наличию (available — есть доступные, none — доступных нет, engineers — на руках у инженеров),
   * словам поиска (артикул, наименование) и сортировке из окна «Склад».
   */
  private async inventoryPartRows(
    query: { readonly search?: string; readonly state?: string; readonly stock?: string; readonly sort?: string },
    limit: number,
    offset: number
  ): Promise<{ readonly items: readonly InventoryPartRecord[]; readonly total: number }> {
    while (this.inventoryRegistryAvailable) {
      const select = this.inventoryExtraColumnsAvailable
        ? `${INVENTORY_REGISTRY_SELECT}, ${INVENTORY_REGISTRY_EXTRA_SELECT}`
        : INVENTORY_REGISTRY_SELECT;
      let request = this.db().from("inventory_part_registry").select(select, { count: "exact" });
      if (query.state === "active" || query.state === "low") request = request.eq("is_active", true);
      if (query.state === "low") request = request.eq("below_minimum", true);
      if (query.state === "inactive") request = request.eq("is_active", false);
      // Наличие считаем по доступному остатку (на складе минус резервы), а не по приходу.
      if (query.stock === "available") request = request.gt("available_quantity", 0);
      if (query.stock === "none") request = request.lte("available_quantity", 0);
      if (query.stock === "engineers") request = request.gt("with_engineers_quantity", 0);
      for (const token of searchTokens(query.search)) request = request.ilike("search_text", searchTextPattern(token));
      for (const [column, ascending] of INVENTORY_SORTS.get(query.sort ?? "") ?? DEFAULT_INVENTORY_SORT) {
        request = request.order(column, { ascending });
      }
      const { data, error, count } = await request.range(offset, offset + limit - 1);
      if (!error) return { items: (data ?? []).map((item) => inventoryPartRecord(asRow(item))), total: count ?? 0 };
      // Столбцов 0047/0050 в базе ещё нет: читаем склад без них, остальное работает.
      if (this.inventoryExtraColumnsAvailable && /aliases|on_hand_new|on_hand_guarantee|on_hand_used|available_new|available_guarantee|available_used/iu.test(error.message ?? "")) {
        this.inventoryExtraColumnsAvailable = false;
        console.warn("В базе нет псевдонимов и остатков по состояниям: склад читаем без них", error.message);
        continue;
      }
      if (!isMissingSchemaObject(error, "inventory_part_registry")) {
        throwIfError(error, "Не получилось загрузить склад");
      }
      this.inventoryRegistryAvailable = false;
    }
    return this.legacyInventoryPartRows(query, limit, offset);
  }

  /**
   * Склад без миграции 0025, как раньше: фильтр только «Активные», порядок по наименованию.
   * Остатки в этой базе считаются уже после выборки, поэтому фильтра по наличию здесь нет:
   * он отсеивал бы строки после подсчёта страницы и общее число перестало бы сходиться.
   */
  private async legacyInventoryPartRows(
    query: { readonly search?: string; readonly state?: string },
    limit: number,
    offset: number
  ): Promise<{ readonly items: readonly InventoryPartRecord[]; readonly total: number }> {
    let request = this.db().from("parts").select(PART_SELECT, { count: "exact" }).order("name").range(offset, offset + limit - 1);
    const term = escapePostgrestSearchTerm(query.search ?? "");
    if (term) request = request.or(`article_number.ilike.%${term}%,name.ilike.%${term}%`);
    if (query.state === "active") request = request.eq("is_active", true);
    const { data, error, count } = await request;
    throwIfError(error);
    return { items: await this.inventoryRecordsFromParts((data ?? []).map((item) => asRow(item))), total: count ?? 0 };
  }

  /** Карточки над складом по всему складу (функция 0025). Функции в базе нет: undefined, сводка по странице, как раньше. */
  private async inventoryPartSummary(): Promise<InventoryPartPage["summary"] | undefined> {
    if (!this.inventorySummaryAvailable) return undefined;
    const { data, error } = await this.db().rpc("inventory_part_summary", {}, { get: true });
    if (isMissingSchemaObject(error, "inventory_part_summary")) {
      this.inventorySummaryAvailable = false;
      return undefined;
    }
    if (error) {
      // Сводка не должна ронять весь склад: карточки посчитаем по странице, как раньше.
      console.warn("Сводка склада не посчиталась", error.message);
      return undefined;
    }
    const row = Array.isArray(data) ? asRow(data[0]) : asRow(data);
    return {
      active: numberValue(row.active) ?? 0,
      belowMinimum: numberValue(row.below_minimum) ?? 0,
      withEngineers: numberValue(row.with_engineers) ?? 0
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
    /** Цена единицы в этом приходе: из неё счёт берёт стоимость запчасти (0040). */
    readonly unitPrice?: number;
  }): Promise<InventoryPartRecord> {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new M2ApiError(400, "Укажите количество больше нуля");
    }
    const unitPrice = input.unitPrice === undefined ? undefined : Number(input.unitPrice);
    if (unitPrice !== undefined && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      throw new M2ApiError(400, "Цена прихода не может быть отрицательной");
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
        ...(unitPrice === undefined ? {} : { receipt_unit_price: unitPrice }),
        ...(input.sourceDocument ? { source_document: input.sourceDocument } : {})
      }).select("id").single();
      throwIfError(lotCreateError, "Не получилось подготовить партию на складе");
      lotId = text(asRow(createdLot), "id");
    } else if (unitPrice !== undefined) {
      // Приход этой запчасти в этом состоянии всегда идёт в одну и ту же партию,
      // поэтому цена здесь и есть «последняя цена прихода»: её же берёт счёт.
      // Читать её обратно склад не может (0040), поэтому и не читаем — только пишем.
      const { error: priceError } = await this.db().from("stock_lots")
        .update({ receipt_unit_price: unitPrice }).eq("id", lotId);
      throwIfError(priceError, "Запчасть оприходована, но цена прихода не сохранилась");
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

  /**
   * История движений по позиции (функция базы 0048): приход, выдача, установка, возврат,
   * списание и корректировка с датой, автором, причиной и ссылками на задачу и прибор.
   * Цены прихода в истории нет: складу и инженеру она закрыта (0040).
   */
  public async inventoryPartMovements(partId: string, limit = 100, offset = 0): Promise<StockMovementPage> {
    const { data, error } = await this.db().rpc("inventory_part_movements", {
      p_part_id: partId,
      p_limit: limit,
      p_offset: offset
    }, { get: true });
    throwIfError(error, "Не получилось загрузить историю движений");
    const rows = Array.isArray(data) ? data.map((item) => asRow(item)) : [];
    return {
      items: rows.map((row) => stockMovementRecord(row)),
      // Общее число приходит с каждой строкой; пустая страница — значит, движений нет.
      total: rows.length ? numberValue(rows[0]?.total_count) ?? rows.length : 0
    };
  }

  /**
   * Документы склада (0062): перемещение на склад инженера, возврат и списание.
   * Создаёт их база при движении запчасти; здесь только список с отбором.
   * Запрос POST, а не GET: в адресе пустой отбор ушёл бы строкой «null», и база
   * не разобрала бы её как номер задачи (на стенде 17.11.2026 — ответ 400).
   */
  public async stockDocumentPage(input: {
    readonly kind?: StockDocumentKind | "";
    readonly search?: string;
    readonly from?: string;
    readonly to?: string;
    readonly taskId?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<StockDocumentPage> {
    const { data, error } = await this.db().rpc("stock_document_list", {
      p_kind: input.kind || null,
      p_search: input.search?.trim() || null,
      p_from: input.from || null,
      p_to: input.to || null,
      p_task_id: input.taskId || null,
      p_limit: input.limit ?? 50,
      p_offset: input.offset ?? 0
    });
    throwIfError(error, "Не получилось загрузить документы склада");
    const rows = Array.isArray(data) ? data.map((item) => asRow(item)) : [];
    return {
      items: rows.map((row) => stockDocumentRecord(row)),
      total: rows.length ? numberValue(rows[0]?.total_count) ?? rows.length : 0
    };
  }

  /** Строки документов склада: артикул, наименование, состояние и количество (0062). */
  public async stockDocumentLines(documentIds: readonly string[]): Promise<readonly StockDocumentLine[]> {
    if (documentIds.length === 0) return [];
    const { data, error } = await this.db().rpc("stock_document_lines_for", { p_document_ids: [...documentIds] });
    throwIfError(error, "Не получилось загрузить строки документа");
    return Array.isArray(data) ? data.map((item) => stockDocumentLine(asRow(item))) : [];
  }

  /** Псевдонимы артикула запчасти: тот же артикул у других поставщиков (0047). */
  public async partAliases(partId: string): Promise<readonly PartAliasRecord[]> {
    const { data, error } = await this.db().from("part_aliases")
      .select("id, alias, created_at").eq("part_id", partId).order("alias");
    throwIfError(error, "Не получилось загрузить псевдонимы артикула");
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return { id: text(row, "id"), alias: text(row, "alias"), createdAt: text(row, "created_at") };
    });
  }

  /** Добавить псевдоним артикула. Дубли и чужие артикулы отказывает база сообщением по-русски (0047). */
  public async addPartAlias(partId: string, alias: string): Promise<void> {
    const value = alias.trim();
    if (!value) throw new M2ApiError(400, "Напишите артикул поставщика");
    const { error } = await this.db().from("part_aliases").insert({ part_id: partId, alias: value });
    throwIfError(error, "Не получилось добавить псевдоним");
  }

  /** Убрать псевдоним: сам артикул запчасти остаётся, движения и история не меняются. */
  public async removePartAlias(id: string): Promise<void> {
    const { error } = await this.db().from("part_aliases").delete().eq("id", id);
    throwIfError(error, "Не получилось убрать псевдоним");
  }

  /**
   * Списать запчасть со склада: брак, утеря, бой (функция базы 0049). Причину, остаток
   * и зарезервированное проверяет база, её сообщение показываем как есть.
   * Возвращает остаток в этом состоянии после списания.
   */
  public async writeOffInventoryPart(input: {
    readonly partId: string;
    readonly condition: "G" | "N" | "B";
    readonly quantity: number;
    readonly reason: string;
  }): Promise<number> {
    const { data, error } = await this.db().rpc("write_off_stock", {
      p_part_id: input.partId,
      p_condition: input.condition,
      p_quantity: input.quantity,
      p_reason: input.reason
    });
    throwIfError(error, "Не получилось списать запчасть");
    return numberValue(data) ?? 0;
  }

  /**
   * Привести остаток к факту после инвентаризации (функция базы 0049): кладовщик вводит
   * посчитанное количество, разницу база проводит встречным движением.
   */
  public async adjustInventoryPart(input: {
    readonly partId: string;
    readonly condition: "G" | "N" | "B";
    readonly countedQuantity: number;
    readonly reason: string;
  }): Promise<number> {
    const { data, error } = await this.db().rpc("adjust_stock", {
      p_part_id: input.partId,
      p_condition: input.condition,
      p_counted_quantity: input.countedQuantity,
      p_reason: input.reason
    });
    throwIfError(error, "Не получилось поправить остаток");
    return numberValue(data) ?? 0;
  }

  /**
   * Что база распознала в накладной (функция 0050). Ничего не меняет: приход идёт
   * только после подтверждения человеком, отдельным вызовом receiveStockBatch.
   */
  public async previewStockReceipt(items: readonly StockReceiptInputRow[]): Promise<readonly StockReceiptPreviewRow[]> {
    // Обычным запросом (POST), а не { get: true }: в строку адреса postgrest-js складывает
    // массив через join, и накладная превратилась бы в «{[object Object],[object Object]}».
    // Функция объявлена STABLE и ничего не меняет — приход идёт отдельным вызовом.
    const { data, error } = await this.db().rpc("preview_stock_receipt", { p_items: items });
    throwIfError(error, "Не получилось разобрать файл накладной");
    return (Array.isArray(data) ? data : []).map((item) => stockReceiptPreviewRow(asRow(item)));
  }

  /** Оприходовать накладную целиком (функция 0050): ошибка хотя бы в одной строке — не проходит ни одна. */
  public async receiveStockBatch(items: readonly StockReceiptInputRow[]): Promise<readonly StockReceiptAppliedRow[]> {
    const { data, error } = await this.db().rpc("receive_stock_batch", { p_items: items });
    throwIfError(error, "Не получилось оприходовать накладную");
    return (Array.isArray(data) ? data : []).map((item) => {
      const row = asRow(item);
      const condition = text(row, "part_condition");
      return {
        partId: text(row, "part_id"),
        partArticle: text(row, "part_article"),
        partName: text(row, "part_name"),
        condition: condition === "G" || condition === "B" ? condition : "N",
        quantity: numberValue(row.quantity) ?? 0,
        onHandAfter: numberValue(row.on_hand_after) ?? 0
      };
    });
  }

  private async loadInventoryPart(id: string): Promise<InventoryPartRecord> {
    const { data, error } = await this.db().from("parts").select(PART_SELECT).eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Номенклатура не найдена");
    const [record] = await this.inventoryRecordsFromParts([asRow(data)]);
    if (!record) throw new M2ApiError(404, "Номенклатура не найдена");
    return record;
  }

  /**
   * Остатки по состояниям (stock_balances) и выданное инженерам для строк parts:
   * карточка запчасти и склад без миграции 0025. Считается так же, как inventory_part_registry.
   */
  private async inventoryRecordsFromParts(rows: readonly Row[]): Promise<readonly InventoryPartRecord[]> {
    const ids = rows.map((row) => text(row, "id"));
    if (ids.length === 0) return [];
    const [{ data: balances, error: balanceError }, withEngineersByPart, aliasesByPart] = await Promise.all([
      this.db().from("stock_balances").select("part_id, part_condition, on_hand_quantity, reserved_quantity, available_quantity").in("part_id", ids),
      this.issuedQuantityByPart(ids),
      this.aliasesByPart(ids)
    ]);
    throwIfError(balanceError);
    const totals = new Map<string, Row>();
    for (const item of balances ?? []) {
      const balance = asRow(item);
      const partId = text(balance, "part_id");
      const condition = text(balance, "part_condition");
      const current = totals.get(partId) ?? {
        on_hand_quantity: 0, reserved_quantity: 0, available_quantity: 0,
        on_hand_guarantee: 0, on_hand_new: 0, on_hand_used: 0,
        available_guarantee: 0, available_new: 0, available_used: 0
      };
      const onHand = numberValue(balance.on_hand_quantity) ?? 0;
      const available = numberValue(balance.available_quantity) ?? 0;
      // Остаток по состояниям, как его считает представление 0050: по строкам stock_balances.
      const onHandKey = condition === "G" ? "on_hand_guarantee" : condition === "B" ? "on_hand_used" : "on_hand_new";
      const availableKey = condition === "G" ? "available_guarantee" : condition === "B" ? "available_used" : "available_new";
      totals.set(partId, {
        ...current,
        on_hand_quantity: (numberValue(current.on_hand_quantity) ?? 0) + onHand,
        reserved_quantity: (numberValue(current.reserved_quantity) ?? 0) + (numberValue(balance.reserved_quantity) ?? 0),
        available_quantity: (numberValue(current.available_quantity) ?? 0) + available,
        [onHandKey]: (numberValue(current[onHandKey]) ?? 0) + onHand,
        [availableKey]: (numberValue(current[availableKey]) ?? 0) + available
      });
    }
    return rows.map((row) => {
      const id = text(row, "id");
      return inventoryPartRecord({
        ...row,
        ...totals.get(id),
        with_engineers_quantity: withEngineersByPart.get(id) ?? 0,
        ...(aliasesByPart.get(id) ? { aliases: aliasesByPart.get(id) } : {})
      });
    });
  }

  /** Псевдонимы артикулов (0047) одной строкой на запчасть: так же, как их собирает представление склада. */
  private async aliasesByPart(partIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    if (partIds.length === 0) return result;
    const { data, error } = await this.db().from("part_aliases").select("part_id, alias").in("part_id", [...partIds]).order("alias");
    // Псевдонимы — не повод ронять карточку запчасти: без них просто не будет колонки.
    if (error) {
      console.warn("Псевдонимы артикулов не прочитались", error.message);
      return result;
    }
    for (const item of data ?? []) {
      const row = asRow(item);
      const partId = text(row, "part_id");
      const alias = text(row, "alias").trim();
      if (!alias) continue;
      result.set(partId, result.has(partId) ? `${result.get(partId)}, ${alias}` : alias);
    }
    return result;
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
    return this.loadReservations((select) => {
      const request = this.db().from("stock_reservations").select(select);
      return state === "active"
        ? request.in("status", [...ACTIVE_RESERVATION_STATUSES]).order("created_at").order("number").limit(500)
        : request.in("status", [...CLOSED_RESERVATION_STATUSES]).order("updated_at", { ascending: false }).limit(100);
    }, "Не получилось загрузить резервы");
  }

  /**
   * Все резервы состояния для выгрузки — страницами, а не первые 500 или 100, как окно
   * склада. Порядок тот же, что на экране, плюс номер как добивка: без неё страницы
   * с одинаковым временем могли бы перемешаться и строка потерялась бы.
   *
   * Останавливаемся на пустом ответе, а не на короткой странице: сервер отдаёт за раз
   * не больше своего предела (db-max-rows), и короткая страница ещё не значит, что
   * резервы кончились. Ценой одного лишнего пустого запроса в конце.
   */
  public async allStockReservations(state: "active" | "closed" = "active"): Promise<readonly StockReservationRecord[]> {
    const pageSize = 500;
    const rows: StockReservationRecord[] = [];
    // Предел тот же, что у выгрузки реестров (REGISTRY_EXPORT_MAX_ROWS): случайный
    // отбор на всю базу не должен положить браузер. Числом, а не ссылкой на константу:
    // registry-export зависит от этого файла, и обратная связь замкнула бы импорты.
    while (rows.length < 20_000) {
      const offset = rows.length;
      const chunk = await this.loadReservations((select) => {
        const request = this.db().from("stock_reservations").select(select);
        return (state === "active"
          ? request.in("status", [...ACTIVE_RESERVATION_STATUSES]).order("created_at").order("number")
          : request.in("status", [...CLOSED_RESERVATION_STATUSES]).order("updated_at", { ascending: false }).order("number")
        ).range(offset, offset + pageSize - 1);
      }, "Не получилось выгрузить резервы");
      if (chunk.length === 0) break;
      rows.push(...chunk);
    }
    return rows;
  }

  /** Резервы одной задачи с шагами истории: карточка задачи и форма результата инженера. */
  public async taskReservations(taskId: string): Promise<readonly StockReservationRecord[]> {
    return this.loadReservations(
      (select) => this.db().from("stock_reservations").select(select).eq("task_id", taskId).order("created_at").order("number"),
      "Не получилось загрузить резервы задачи"
    );
  }

  /**
   * Резервы с шагами истории. Если встроить историю (или имена авторов) не удалось — например,
   * миграции 0028 в базе ещё нет, — читаем резервы как раньше, без шагов, а не падаем.
   */
  private async loadReservations(
    request: (select: string) => PromiseLike<{ readonly data: unknown[] | null; readonly error: { readonly message?: string } | null }>,
    fallback: string
  ): Promise<readonly StockReservationRecord[]> {
    // Отметка установки и история отваливаются по отдельности: каждая неудача убирает из
    // запроса только своё, остальное продолжает работать.
    for (let attempt = 0; attempt <= RESERVATION_HISTORY_SELECTS.length; attempt += 1) {
      const select = [
        RESERVATION_SELECT,
        RESERVATION_PART_SELECTS[this.reservationAliasesAvailable ? 0 : 1] as string,
        ...(this.reservationMarkAvailable ? [RESERVATION_MARK_SELECT] : []),
        ...(RESERVATION_HISTORY_SELECTS[this.reservationHistoryLevel] ? [RESERVATION_HISTORY_SELECTS[this.reservationHistoryLevel] as string] : [])
      ].join(", ");
      const { data, error } = await request(select);
      if (!error) return (data ?? []).map((item) => stockReservationRecord(asRow(item)));
      const message = error.message ?? "";
      if (this.reservationAliasesAvailable && /part_aliases/iu.test(message)) {
        this.reservationAliasesAvailable = false;
        console.warn("Псевдонимы артикулов не встроились: резервы ищем по артикулу и наименованию", message);
        continue;
      }
      if (this.reservationMarkAvailable && /install_marked/iu.test(message)) {
        this.reservationMarkAvailable = false;
        console.warn("В базе нет install_marked: отметки об установке появятся после обновления базы", message);
        continue;
      }
      if (this.reservationHistoryLevel < RESERVATION_HISTORY_SELECTS.length - 1 && /stock_reservation_history|changed_by|changer/iu.test(message)) {
        this.reservationHistoryLevel += 1;
        console.warn("Шаги резерва не встроились: читаем резервы без истории", message);
        continue;
      }
      throwIfError(error, fallback);
    }
    return [];
  }

  /**
   * Сколько запчасти доступно по состояниям Г/Н/Б (stock_balances). Нужно окну резерва:
   * база всё равно проверит остаток, но лишний раз ошибку ловить не придётся.
   */
  public async inventoryPartAvailability(partId: string): Promise<Readonly<Record<"G" | "N" | "B", number>>> {
    const { data, error } = await this.db().from("stock_balances").select("part_condition, available_quantity").eq("part_id", partId);
    throwIfError(error, "Не получилось прочитать остатки по состояниям");
    const totals: Record<"G" | "N" | "B", number> = { G: 0, N: 0, B: 0 };
    for (const item of data ?? []) {
      const row = asRow(item);
      const condition = text(row, "part_condition");
      if (condition === "G" || condition === "N" || condition === "B") totals[condition] += numberValue(row.available_quantity) ?? 0;
    }
    return totals;
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

  /**
   * Зарезервировать запчасть под задачу (функция базы 0028). Права, этап задачи и остаток
   * проверяет база: её сообщение («На складе доступно 1 шт. …») показываем как есть.
   */
  public async createTaskPartReservation(
    taskId: string,
    input: { readonly partId: string; readonly condition: "G" | "N" | "B"; readonly quantity: number }
  ): Promise<{ readonly id: string; readonly number: string }> {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new M2ApiError(400, "Укажите количество больше нуля");
    const { data, error } = await this.db().rpc("create_task_part_reservation", {
      p_task_id: taskId,
      p_part_id: input.partId,
      p_condition: input.condition,
      p_quantity: quantity
    });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Резерв запчастей заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось зарезервировать запчасть");
    const row = Array.isArray(data) ? asRow(data[0]) : asRow(data);
    return { id: text(row, "id"), number: text(row, "number") };
  }

  /**
   * Отметки «установлена» по выданным на задачу резервам (функция базы 0028): перечисленные
   * резервы получают строку в запчастях задачи с installed=true, остальные выданные — false.
   */
  public async setTaskPartsInstalled(taskId: string, reservationIds: readonly string[]): Promise<void> {
    const { error } = await this.db().rpc("set_task_parts_installed", { p_task_id: taskId, p_reservation_ids: [...reservationIds] });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Отметки об установке заработают после обновления базы на сервере");
    throwIfError(error, "Не получилось отметить установленные запчасти");
  }

  private async changeStockReservationStatus(id: string, status: StockReservationStatus, from: readonly StockReservationStatus[], fallback: string): Promise<void> {
    const { data, error } = await this.db().from("stock_reservations").update({ status }).eq("id", id).in("status", [...from]).select("id");
    throwIfError(error, fallback);
    if (!data?.length) throw new M2ApiError(409, "Резерв уже в другом состоянии. Обновите список резервов.");
  }

  private async stockReservationRpc(fn: "issue_stock_reservation" | "return_stock_reservation", id: string, fallback: string): Promise<void> {
    const { error } = await this.db().rpc(fn, { p_reservation_id: id });
    if (isMissingDatabaseFunction(error)) {
      throw new M2ApiError(501, "Выдача и возврат заработают после обновления базы на сервере");
    }
    throwIfError(error, fallback);
  }

  /**
   * Отчёт за период. Разрезы считает база (миграции 0044 и 0045): на стенде тысячи
   * задач, и тянуть их в браузер ради восьми разбивок нельзя. Деньги приходят только
   * с правом `finance.read` — и спрашиваем мы их тоже только с ним, чтобы в журнале
   * сервера не было лишних запросов от инженера.
   *
   * Пока миграций нет на сервере, отчёт откатывается к прежнему расчёту в браузере:
   * страница продолжает показывать старые цифры, новые разрезы остаются пустыми,
   * и об этом говорит флаг databaseCuts.
   */
  public async operationsReport(from: string, to: string): Promise<OperationsReportRecord> {
    const canSeeFinance = await this.hasPermission("finance.read");
    const period = { p_from: from, p_to: to };
    // Все разрезы одним заходом. Деньги спрашиваем только с правом на них, чтобы
    // в журнале сервера не было заведомо пустых запросов от тех, кому их не видно.
    const [summary, breakdown, parts, load, equipmentSpend, payerSpend] = await Promise.all([
      this.db().rpc("report_task_summary", period),
      this.db().rpc("report_task_breakdown", period),
      this.db().rpc("report_part_warranty", period),
      this.db().rpc("report_engineer_load", period),
      canSeeFinance ? this.db().rpc("report_equipment_spend", period) : null,
      canSeeFinance ? this.db().rpc("report_payer_spend", period) : null
    ]);
    if (isMissingDatabaseFunction(summary.error) || isMissingDatabaseFunction(breakdown.error)) {
      return this.operationsReportInBrowser(from, to, canSeeFinance);
    }
    throwIfError(summary.error, "Не получилось построить отчёт");
    throwIfError(breakdown.error, "Не получилось построить отчёт");
    // Миграции на стенд применяют по одной, и 0045 может отстать от 0044. Разрез,
    // функции которого ещё нет, остаётся пустым — валить из-за него весь отчёт нельзя.
    const cutRowsOf = (result: { readonly data: unknown; readonly error: { readonly code?: string; readonly message?: string } | null } | null, fallback: string): readonly unknown[] => {
      if (!result || isMissingDatabaseFunction(result.error)) return [];
      throwIfError(result.error, fallback);
      return (result.data ?? []) as readonly unknown[];
    };
    // Денег нет не потому, что счетов не было, а потому, что функции ещё нет в базе:
    // это разные вещи, и интерфейс должен сказать правду.
    const spendMissing = isMissingDatabaseFunction(equipmentSpend?.error ?? null)
      || isMissingDatabaseFunction(payerSpend?.error ?? null);
    const partRows = cutRowsOf(parts, "Не получилось посчитать гарантийность замен");
    const loadRows = cutRowsOf(load, "Не получилось посчитать загрузку инженеров");
    const equipmentSpendRows = cutRowsOf(equipmentSpend, "Не получилось посчитать затраты по приборам");
    const payerSpendRows = cutRowsOf(payerSpend, "Не получилось посчитать затраты по плательщикам");
    const summaryRow = asRow(Array.isArray(summary.data) ? summary.data[0] : summary.data);
    const cuts = (section: string): readonly ReportCutItem[] => ((breakdown.data ?? []) as readonly unknown[])
      .map((item: unknown) => asRow(item))
      .filter((row: Row) => text(row, "section") === section)
      .map((row: Row) => ({
        code: text(row, "item_code"),
        name: text(row, "item_name"),
        value: numberValue(row.task_count) ?? 0,
        closed: numberValue(row.closed_count) ?? 0,
        overdue: numberValue(row.overdue_count) ?? 0
      }));
    const taskCount = numberValue(summaryRow.task_count) ?? 0;
    const months = new Map(cuts("month").map((item) => [item.code, item.value] as const));
    return {
      period: { from, to },
      metrics: {
        taskCount,
        closedCount: numberValue(summaryRow.closed_count) ?? 0,
        closedOnTimePercent: numberValue(summaryRow.closed_on_time_percent) ?? 0,
        overdueCount: numberValue(summaryRow.overdue_count) ?? 0,
        activeEngineerCount: numberValue(summaryRow.engineer_count) ?? 0,
        belowMinimumCount: 0
      },
      tasksByStatus: cuts("status").map((item) => ({
        code: item.code,
        // Названия этапов в отчёте те же, что в остальном интерфейсе.
        name: TASK_STATUS_LABELS[item.code] ?? item.name,
        value: item.value
      })),
      tasksByWorkType: cuts("work_type"),
      // Пустые месяцы периода тоже нужны: иначе в графике пропадёт провал.
      tasksByMonth: reportMonthsInRange(from, to).map((key) => ({
        key,
        name: reportMonthLabel(key),
        value: months.get(key) ?? 0
      })),
      tasksByReason: cuts("reason"),
      worksByModifier: cuts("modifier"),
      tasksByEquipment: cuts("equipment"),
      tasksBySite: cuts("site"),
      tasksByEngineer: cuts("engineer"),
      partsByCondition: partRows.map((item: unknown) => {
        const row = asRow(item);
        return {
          code: text(row, "condition_code"),
          name: text(row, "condition_name"),
          taskCount: numberValue(row.task_count) ?? 0,
          positionCount: numberValue(row.position_count) ?? 0,
          quantity: numberValue(row.quantity) ?? 0
        };
      }),
      engineerLoad: loadRows.map((item: unknown) => {
        const row = asRow(item);
        return {
          engineerId: text(row, "engineer_id"),
          name: text(row, "engineer_name"),
          taskCount: numberValue(row.task_count) ?? 0,
          closedCount: numberValue(row.closed_count) ?? 0,
          overdueCount: numberValue(row.overdue_count) ?? 0,
          busyDays: numberValue(row.busy_days) ?? 0,
          periodDays: numberValue(row.period_days) ?? 0,
          workHours: numberValue(row.work_hours) ?? 0
        };
      }),
      equipmentSpend: equipmentSpendRows.map((item: unknown) => {
        const row = asRow(item);
        const serial = text(row, "serial_number");
        const model = optionalText(row, "equipment_name");
        return {
          id: text(row, "equipment_id"),
          // Названия прибора может не быть: деньги видны по finance.read, а приборы
          // по своему праву, и строку затрат из-за этого не теряем.
          name: [model, serial].filter(Boolean).join(" · ") || "Прибор",
          ...(optionalText(row, "site_name") || optionalText(row, "payer_name")
            ? { detail: [optionalText(row, "site_name"), optionalText(row, "payer_name")].filter(Boolean).join(" · ") }
            : {}),
          taskCount: numberValue(row.task_count) ?? 0,
          invoiceCount: numberValue(row.invoice_count) ?? 0,
          workAmount: numberValue(row.work_amount) ?? 0,
          partsAmount: numberValue(row.parts_amount) ?? 0,
          totalAmount: numberValue(row.total_amount) ?? 0
        };
      }),
      payerSpend: payerSpendRows.map((item: unknown) => {
        const row = asRow(item);
        return {
          id: text(row, "payer_id"),
          name: text(row, "payer_name"),
          taskCount: numberValue(row.task_count) ?? 0,
          invoiceCount: numberValue(row.invoice_count) ?? 0,
          workAmount: numberValue(row.work_amount) ?? 0,
          partsAmount: numberValue(row.parts_amount) ?? 0,
          adjustmentAmount: numberValue(row.adjustment_amount) ?? 0,
          totalAmount: numberValue(row.total_amount) ?? 0
        };
      }),
      canSeeFinance,
      databaseCuts: true,
      databaseSpend: !spendMissing
    };
  }

  /** Прежний расчёт в браузере: страховка на время, пока на сервере нет миграций 0044 и 0045. */
  private async operationsReportInBrowser(from: string, to: string, canSeeFinance: boolean): Promise<OperationsReportRecord> {
    const bounds = reportPeriodBounds(from, to);
    // «Сегодня» по Москве один раз на весь отчёт, а не на каждую задачу.
    const today = companyToday();
    // Все заявки периода, а не первые 1000: столько сервер отдаёт за один запрос.
    const [tasks, workTypesResult] = await Promise.all([
      allPages((start, end, withCount) => this.db().from("tasks")
        .select("id, status_code, work_type_code, deadline_to, completed_at, created_at", withCount ? { count: "exact" } : undefined)
        .gte("created_at", bounds.start).lt("created_at", bounds.endBefore)
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
          return reportTaskOverdue(optionalText(row, "deadline_to"), text(row, "status_code"), to, today);
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
      })),
      tasksByReason: [],
      worksByModifier: [],
      tasksByEquipment: [],
      tasksBySite: [],
      tasksByEngineer: [],
      partsByCondition: [],
      engineerLoad: [],
      equipmentSpend: [],
      payerSpend: [],
      canSeeFinance,
      databaseCuts: false,
      databaseSpend: false
    };
  }

  /**
   * Заявки за период для выгрузки в Excel: те же, что считает отчёт (созданные в периоде),
   * с площадкой, прибором и инженером. Читаем страницами по 1000, как отдаёт сервер.
   */
  public async operationsReportTasks(from: string, to: string): Promise<readonly ReportTaskRow[]> {
    const pageSize = 1000;
    const select = "id, number, title, status_code, priority, work_type_code, deadline_from, deadline_to, completed_at, work_finished_at, created_at, "
      + "site:sites!site_id(name), device:equipment!equipment_id(serial_number, model:equipment_models(name), maker:manufacturers(name)), "
      + "engineer:users!engineer_id(full_name)";
    // Справочники и заявки читаем одновременно, а не друг за другом.
    const [workTypesResult, statusesResult, page] = await Promise.all([
      this.db().from("work_types").select("code, name"),
      this.db().from("task_statuses").select("code, name"),
      allPages((start, end, withCount) => this.db().from("tasks")
        .select(select, withCount ? { count: "exact" } : undefined)
        .gte("created_at", reportPeriodBounds(from, to).start).lt("created_at", reportPeriodBounds(from, to).endBefore)
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
        ...(optionalText(row, "completed_at") ? { completedAt: optionalText(row, "completed_at") } : {}),
        ...(optionalText(row, "work_finished_at") ? { workFinishedAt: optionalText(row, "work_finished_at") } : {})
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

  /** Этап и номер выбранных задач одним запросом: массовые операции решают, что с какой задачей можно. */
  private async bulkTaskStates(taskIds: readonly string[]): Promise<ReadonlyMap<string, { readonly status: string; readonly number: string }>> {
    if (taskIds.length === 0) return new Map();
    const { data, error } = await this.db().from("tasks").select("id, status_code, number").in("id", [...taskIds]);
    throwIfError(error);
    return new Map((data ?? []).map((item) => {
      const row = asRow(item);
      return [text(row, "id"), { status: text(row, "status_code"), number: text(row, "number") }] as const;
    }));
  }

  public async bulkAssignTasks(taskIds: readonly string[], engineerId: string): Promise<BulkTaskCommandResponse> {
    const succeededTaskIds: string[] = [];
    const failures: Array<{ readonly taskId: string; readonly code: "conflict" | "invalid_status" | "not_found"; readonly error: string }> = [];
    const states = await this.bulkTaskStates(taskIds);
    for (const taskId of taskIds) {
      const state = states.get(taskId);
      if (!state) { failures.push({ taskId, code: "not_found", error: "Задача не найдена" }); continue; }
      const mode = bulkAssignMode(state.status);
      if (mode === "refuse") {
        failures.push({ taskId, code: "invalid_status", error: `${state.number}: задача ${TASK_STATUS_LABELS[state.status]?.toLowerCase() ?? state.status}, инженера не меняем` });
        continue;
      }
      try {
        if (mode === "assign") await this.assignTask(taskId, engineerId);
        else await this.reassignTask(taskId, engineerId);
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
    const states = await this.bulkTaskStates(taskIds);
    for (const taskId of taskIds) {
      const state = states.get(taskId);
      if (!state) { failures.push({ taskId, code: "not_found", error: "Задача не найдена" }); continue; }
      // Срок закрытой или отменённой задачи не меняем: от него считается «закрыто вовремя».
      if (state.status === "closed" || state.status === "cancelled") {
        failures.push({ taskId, code: "invalid_status", error: `${state.number}: задача ${TASK_STATUS_LABELS[state.status]?.toLowerCase() ?? state.status}, срок не меняем` });
        continue;
      }
      const { error } = await this.db().from("tasks").update({ deadline_from: periodFrom, deadline_to: periodTo }).eq("id", taskId);
      if (error) failures.push({ taskId, code: "conflict", error: publicApiErrorMessage(error.message, "Не получилось сменить срок") });
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
  public async taskReviewReadiness(id: string): Promise<{ readonly hasClosure: boolean; readonly resultFilled: boolean; readonly photoCount: number }> {
    const [task, closure, photos] = await Promise.all([
      this.db().from("tasks").select("call_reason, work_description").eq("id", id).maybeSingle(),
      this.db().from("task_closures").select("task_id").eq("task_id", id).maybeSingle(),
      this.db().from("files").select("id", { count: "exact", head: true }).eq("task_id", id).eq("kind", "photo")
    ]);
    throwIfError(task.error);
    throwIfError(closure.error);
    throwIfError(photos.error);
    const row = task.data ? asRow(task.data) : {};
    return {
      hasClosure: Boolean(closure.data),
      resultFilled: Boolean(optionalText(row, "call_reason")?.trim() && optionalText(row, "work_description")?.trim()),
      photoCount: photos.count ?? 0
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

  /**
   * Календарь загрузки за период: инженеры и их задачи из функции базы engineer_calendar
   * (миграция 0051). По дням задачи раскладывает buildEngineerCalendar: база отдаёт только
   * задачи, которые занимают дни периода, поэтому страница не читает весь реестр.
   * Кого видно, решает база: с tasks.read_all всех инженеров, инженеру — только себя.
   */
  public async engineerCalendar(from: string, to: string): Promise<EngineerCalendarData> {
    const { data, error } = await this.db().rpc("engineer_calendar", {
      p_from: taskCalendarDate(from),
      p_to: taskCalendarDate(to)
    }, { get: true });
    if (isMissingSchemaObject(error, "engineer_calendar")) {
      throw new M2ApiError(501, "Календарь загрузки заработает после обновления базы на сервере");
    }
    throwIfError(error, "Не получилось загрузить календарь загрузки");
    const engineers = new Map<string, CalendarEngineer>();
    const tasks: CalendarTask[] = [];
    for (const item of Array.isArray(data) ? data : []) {
      const row = asRow(item);
      // Пустой engineer_id — нераспределённая задача: её видно только тем, кто видит всех.
      const engineerId = optionalText(row, "engineer_id");
      if (engineerId && !engineers.has(engineerId)) {
        engineers.set(engineerId, {
          id: engineerId,
          fullName: text(row, "engineer_name"),
          isActive: row.engineer_is_active !== false
        });
      }
      // У инженера без задач в периоде приходит одна строка с пустой задачей.
      const taskId = optionalText(row, "task_id");
      if (!taskId) continue;
      const priority = optionalText(row, "priority_code");
      tasks.push({
        id: taskId,
        number: text(row, "task_number"),
        title: text(row, "task_title"),
        status: text(row, "task_status"),
        ...(engineerId ? { engineerId } : {}),
        ...(priority === "urgent" || priority === "planned" ? { priority } : {}),
        ...(optionalText(row, "period_from") ? { periodFrom: text(row, "period_from").slice(0, 10) } : {}),
        ...(optionalText(row, "period_to") ? { periodTo: text(row, "period_to").slice(0, 10) } : {}),
        ...(optionalText(row, "visit_date") ? { visitDate: text(row, "visit_date").slice(0, 10) } : {}),
        ...(optionalText(row, "site_name") ? { siteName: text(row, "site_name") } : {}),
        ...(optionalText(row, "equipment_label") ? { equipmentLabel: text(row, "equipment_label") } : {}),
        isOverdue: row.is_overdue === true
      });
    }
    return { engineers: [...engineers.values()], tasks };
  }

  /**
   * Занятость инженеров на период (функция engineer_period_load, миграция 0051): одна строка
   * на человека, сколько бы задач в периоде ни было. Пусто, если функции в базе ещё нет
   * или она отказала: подсказка тогда остаётся прежней — компетенции и «свободен / занят»
   * по числу задач в работе, как было до календаря.
   */
  private async engineerPeriodLoad(
    from: string,
    to: string,
    ignoreTaskId?: string
  ): Promise<readonly EngineerPeriodLoad[] | undefined> {
    if (!this.engineerPeriodLoadAvailable) return undefined;
    const { data, error } = await this.db().rpc("engineer_period_load", {
      p_from: from,
      p_to: to,
      // Пустой параметр не отправляем вовсе: в GET-запросе null уехал бы строкой «null».
      ...(ignoreTaskId ? { p_ignore_task_id: ignoreTaskId } : {})
    }, { get: true });
    if (isMissingSchemaObject(error, "engineer_period_load")) {
      this.engineerPeriodLoadAvailable = false;
      return undefined;
    }
    if (error) {
      // Занятость не должна мешать назначению: без неё подсказка просто беднее.
      console.warn("Занятость инженеров не посчиталась", error.message);
      return undefined;
    }
    return (Array.isArray(data) ? data : []).map((item) => {
      const row = asRow(item);
      return periodLoadFromCounts({
        engineerId: text(row, "engineer_id"),
        taskCount: numberValue(row.task_count) ?? 0,
        busiestDayCount: numberValue(row.busiest_day_count) ?? 0,
        ...(optionalText(row, "busiest_day") ? { busiestDay: text(row, "busiest_day").slice(0, 10) } : {}),
        freeWorkdayCount: numberValue(row.free_workday_count) ?? 0,
        workdayCount: numberValue(row.workday_count) ?? 0,
        overdueTaskCount: numberValue(row.overdue_task_count) ?? 0
      });
    });
  }

  /**
   * Кого назначить: по компетенциям (производитель и линейка модели прибора) и занятости
   * на период самой задачи — кто в эти дни свободен, у кого уже три выезда, кто не работает.
   * Отключённых инженеров не предлагаем: база всё равно не даст назначить их.
   * Подсказка ничего не запрещает: порядок и пояснения, выбор за человеком.
   */
  public async taskAssignmentSuggestions(
    id: string,
    manufacturer: string,
    model?: string,
    period?: { readonly periodFrom?: string; readonly periodTo?: string; readonly visitDate?: string }
  ): Promise<readonly AssignmentSuggestionRecord[]> {
    const range = assignmentLoadRange(period ?? {}, companyToday());
    const [engineers, load] = await Promise.all([
      this.engineers(),
      this.engineerPeriodLoad(range.from, range.to, id).catch(() => undefined)
    ]);
    const byEngineer = new Map((load ?? []).map((item) => [item.engineerId, item]));
    return engineers.filter((engineer) => engineer.isActive).map((engineer) => {
      const engineerLoad = byEngineer.get(engineer.id);
      return {
        engineerId: engineer.id,
        fullName: engineer.fullName,
        isAvailable: engineerLoad ? engineerLoad.isFree : engineer.inProgressTaskCount === 0,
        previouslyWorkedWithEquipment: engineer.competencies.some((competency) => competencyMatchesEquipment(competency, manufacturer, model)),
        ...(engineerLoad ? { load: engineerLoad } : {})
      };
    });
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

  /**
   * Карточка счёта: шапка, позиции, итоги и история статусов. Видно с правом `finance.read` —
   * это решает политика строк в базе. Суммы берём такими, какими их посчитала база:
   * `subtotal` и `total_amount` она пересчитывает триггером, из интерфейса их не правят.
   */
  public async invoiceCard(id: string): Promise<InvoiceCardResponse> {
    const [invoiceResult, itemsResult] = await Promise.all([
      this.db().from("invoices").select(INVOICE_CARD_SELECT).eq("id", id).maybeSingle(),
      this.db().from("invoice_items").select(INVOICE_ITEM_SELECT).eq("invoice_id", id).order("created_at", { ascending: true })
    ]);
    throwIfError(invoiceResult.error, "Не получилось открыть счёт");
    throwIfError(itemsResult.error, "Не получилось загрузить позиции счёта");
    const row = asRow(invoiceResult.data);
    if (!text(row, "id")) throw new M2ApiError(404, "Счёт не найден");
    const payer = related(row, "payer");
    const tasks = Array.isArray(row.invoice_tasks) ? row.invoice_tasks : [];
    const issuedAt = optionalText(row, "issued_at");
    const transferredAt = optionalText(row, "transferred_at");
    return {
      invoice: {
        id: text(row, "id"),
        number: text(row, "number"),
        status: text(row, "status") as InvoiceApiRecord["status"],
        taskIds: tasks.map((entry) => text(asRow(entry), "task_id")).filter(Boolean),
        payer: {
          id: text(payer, "id") || text(row, "payer_id"),
          name: text(payer, "name"),
          requisites: asRow(payer.requisites) as Record<string, string>
        },
        payerSelection: { source: "equipment" },
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        ...(issuedAt ? { issuedAt } : {}),
        ...(transferredAt ? { transferredAt } : {})
      },
      items: (itemsResult.data ?? []).map((item) => invoiceItemRecord(asRow(item))),
      subtotal: numberValue(row.subtotal) ?? 0,
      adjustmentAmount: numberValue(row.adjustment_amount) ?? 0,
      totalAmount: numberValue(row.total_amount) ?? 0,
      correctionReason: optionalText(row, "correction_reason") ?? null,
      statusHistory: await this.invoiceStatusHistory(id)
    };
  }

  /**
   * История статусов счёта: её пишет триггер базы. Автор приходит по связи changed_by → users,
   * а если PostgREST эту связь не отдаёт — читаем историю без автора: карточка важнее подписи.
   */
  private async invoiceStatusHistory(id: string): Promise<readonly { readonly status: string; readonly at: string; readonly actorName: string | null }[]> {
    for (const select of INVOICE_HISTORY_SELECTS) {
      const { data, error } = await this.db().from("invoice_status_history").select(select).eq("invoice_id", id).order("changed_at", { ascending: true });
      if (error) continue;
      return (data ?? []).map((item) => {
        const row = asRow(item);
        return {
          status: text(row, "to_status"),
          at: iso(row.changed_at),
          actorName: optionalText(related(row, "changer"), "full_name") ?? null
        };
      });
    }
    console.warn("История статусов счёта не прочиталась: показываем карточку без неё");
    return [];
  }

  /** Черновик → «Выставлен» (функция базы `issue_invoice`): дату выставления ставит база. */
  public async issueInvoice(id: string): Promise<void> {
    const { error } = await this.db().rpc("issue_invoice", { p_invoice_id: id });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Выставление счёта заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось выставить счёт");
  }

  /** «Выставлен» → «Передан в 1С» (функция базы `transfer_invoice_to_1c`). Дальше счёт не меняют. */
  public async transferInvoiceTo1c(id: string): Promise<void> {
    const { error } = await this.db().rpc("transfer_invoice_to_1c", { p_invoice_id: id });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Передача в 1С заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось передать счёт в 1С");
  }

  /**
   * Корректировка суммы с обязательной причиной (функция базы `correct_invoice`).
   * Причину проверяем до запроса: без неё база всё равно откажет.
   */
  public async correctInvoice(id: string, adjustment: number, reason: string): Promise<void> {
    const amount = Number(adjustment);
    const reasonText = reason.trim();
    if (!Number.isFinite(amount)) throw new M2ApiError(400, "Укажите сумму корректировки числом");
    if (!reasonText) throw new M2ApiError(400, "Напишите причину корректировки");
    const { error } = await this.db().rpc("correct_invoice", { p_invoice_id: id, p_adjustment: amount, p_reason: reasonText });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Корректировка счёта заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось скорректировать счёт");
  }

  /** Пересобрать позиции по текущему прайсу (функция базы `rebuild_invoice_items`), только черновик. */
  public async rebuildInvoiceItems(id: string): Promise<void> {
    const { error } = await this.db().rpc("rebuild_invoice_items", { p_invoice_id: id });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Пересборка позиций заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось пересобрать позиции счёта");
  }

  /**
   * Строки счёта для файла: плоская таблица из функции базы `invoice_export_rows`.
   * Названия столбцов задаёт база, интерфейс только складывает их в файл.
   */
  public async invoiceExportRows(id: string): Promise<readonly Record<string, string | number>[]> {
    const { data, error } = await this.db().rpc("invoice_export_rows", { p_invoice_id: id });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Выгрузка счёта заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось собрать выгрузку счёта");
    return (Array.isArray(data) ? data : []).map((item) => invoiceExportRow(asRow(item)));
  }

  /**
   * Прайс целиком: действующие, прошлые и будущие цены по видам работ. Читать можно
   * с правом `price.read` или `finance.read` — это решает политика строк в базе.
   */
  public async listPriceList(): Promise<readonly PriceRowApiRecord[]> {
    const { data, error } = await this.db().from("price_list")
      .select("id, work_type_code, guarantee_category_id, valid_from, valid_to, amount, include_guarantee_work, created_at")
      .order("work_type_code", { ascending: true })
      .order("valid_from", { ascending: false });
    throwIfError(error, "Не получилось загрузить прайс");
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return {
        id: text(row, "id"),
        workTypeCode: text(row, "work_type_code"),
        guaranteeCategoryId: optionalText(row, "guarantee_category_id") ?? null,
        validFrom: text(row, "valid_from").slice(0, 10),
        validTo: optionalText(row, "valid_to")?.slice(0, 10) ?? null,
        amount: numberValue(row.amount) ?? 0,
        includeGuaranteeWork: row.include_guarantee_work === true,
        createdAt: iso(row.created_at)
      };
    });
  }

  /**
   * Цена вида работ с даты начала (функция базы `set_work_price`). Прошлый период база
   * закрывает сама, цену тем же числом правит на месте, перед будущей ценой ставит конец
   * периода. Писать в `price_list` напрямую нельзя: там стоит страж.
   */
  public async setWorkPrice(input: {
    readonly workTypeCode: string;
    readonly guaranteeCategoryId: string | null;
    readonly amount: number;
    readonly validFrom: string;
    readonly includeGuaranteeWork: boolean;
  }): Promise<void> {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new M2ApiError(400, "Укажите цену: ноль или больше");
    const { error } = await this.db().rpc("set_work_price", {
      p_work_type_code: input.workTypeCode,
      p_guarantee_category_id: input.guaranteeCategoryId,
      p_amount: amount,
      p_valid_from: taskCalendarDate(input.validFrom),
      p_include_guarantee_work: input.includeGuaranteeWork
    });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Прайс заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось сохранить цену");
  }

  /**
   * Одна дата начала на все выбранные позиции (функция базы `bulk_update_work_prices`):
   * база применяет их в одной транзакции и возвращает число изменённых позиций.
   */
  public async bulkUpdateWorkPrices(
    items: readonly {
      readonly workTypeCode: string;
      readonly guaranteeCategoryId: string | null;
      readonly amount: number;
      readonly includeGuaranteeWork: boolean;
    }[],
    validFrom: string
  ): Promise<number> {
    if (items.length === 0) throw new M2ApiError(400, "Выберите хотя бы одну строку прайса");
    if (items.some((item) => !Number.isFinite(Number(item.amount)) || Number(item.amount) < 0)) {
      throw new M2ApiError(400, "Укажите цену: ноль или больше");
    }
    const { data, error } = await this.db().rpc("bulk_update_work_prices", {
      p_items: items.map((item) => ({
        work_type_code: item.workTypeCode,
        guarantee_category_id: item.guaranteeCategoryId,
        amount: Number(item.amount),
        include_guarantee_work: item.includeGuaranteeWork
      })),
      p_valid_from: taskCalendarDate(validFrom)
    });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Прайс заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось изменить цены");
    return numberValue(Array.isArray(data) ? data[0] : data) ?? 0;
  }

  /** Убрать ещё не начавшуюся цену (функция базы `delete_future_work_price`). Историю удалять нельзя. */
  public async deleteFutureWorkPrice(id: string): Promise<void> {
    const { error } = await this.db().rpc("delete_future_work_price", { p_id: id });
    if (isMissingDatabaseFunction(error)) throw new M2ApiError(501, "Прайс заработает после обновления базы на сервере");
    throwIfError(error, "Не получилось убрать цену");
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
        // Признака нет у справочников, от которых база не зависит: там встроенных значений не бывает.
        isBuiltin: row.is_builtin === true,
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
    // Встроенное значение не отключаем: база откажет (0033), но лучше сказать это сразу и по-человечески.
    const existing = (await this.listCatalogValues(key)).find((item) => item.id === id);
    if (existing) assertReferenceValueCanBeHidden(existing);
    const after = await this.updateCatalogValue(key, id, { isActive: false });
    return { mode: "deactivated", after };
  }
}

export const m2Api = new M2ApiClient();
