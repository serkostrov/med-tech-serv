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
  readonly payerId?: string;
  readonly equipmentId?: string;
  readonly engineerId?: string;
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
  readonly customer?: {
    readonly siteName: string;
    readonly address: string;
    readonly contactFullName?: string;
    readonly contactPhone?: string;
    readonly contactEmail?: string;
    readonly payerName?: string;
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

function throwIfError(error: { readonly message?: string } | null, fallback = "Не получилось выполнить запрос"): void {
  if (error) throw new M2ApiError(400, publicApiErrorMessage(error.message, fallback));
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
  status:task_statuses(code, name)
`;

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
  const contract = related(row, "contract");
  const periodTo = optionalText(row, "deadline_to");
  const status = text(row, "status_code");
  const isOverdue = Boolean(periodTo && !["closed", "cancelled"].includes(status) && periodTo < new Date().toISOString().slice(0, 10));
  const hours = numberValue(row.hours);
  const meterReading = numberValue(row.meter_reading);
  const workModifier = text(row, "work_modifier");
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
    payerId: optionalText(row, "payer_id"),
    equipmentId: optionalText(row, "equipment_id"),
    engineerId: optionalText(row, "engineer_id"),
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
    customer: {
      siteName: text(site, "name"),
      address: text(site, "address"),
      contactFullName: optionalText(contact, "full_name"),
      contactPhone: optionalText(contact, "phone"),
      contactEmail: optionalText(contact, "email"),
      payerName: optionalText(payer, "name")
    },
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
    const { data, error } = await this.db().auth.getUser();
    throwIfError(error, "Не удалось прочитать сессию");
    if (!data.user) throw new M2ApiError(401, "Нужна сессия");
    return data.user.id;
  }

  private async loadTask(id: string): Promise<TaskApiRecord> {
    const { data, error } = await this.db().from("tasks").select(TASK_SELECT).eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Задача не найдена");
    return mapTask(asRow(data));
  }

  private async loadEquipment(id: string): Promise<EquipmentApiRecord> {
    const { data, error } = await this.db().from("equipment").select(EQUIPMENT_SELECT).eq("id", id).maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(404, "Прибор не найден");
    return mapEquipment(asRow(data));
  }

  private async signedFile(row: Row, canSeeFinance: boolean): Promise<EquipmentFileResponse | undefined> {
    if (row.is_financial === true && !canSeeFinance) return undefined;
    const key = text(row, "storage_key");
    const { data } = key
      ? await this.db().storage.from("medtech-files").createSignedUrl(key, 3600)
      : { data: null };
    return {
      id: text(row, "id"),
      kind: text(row, "kind") || "document",
      originalName: text(row, "original_name"),
      contentType: text(row, "content_type") || "application/octet-stream",
      byteSize: numberValue(row.byte_size) ?? 0,
      createdAt: iso(row.created_at),
      equipmentId: optionalText(row, "equipment_id"),
      url: data?.signedUrl
    };
  }

  private async mapFiles(rows: readonly unknown[] | null, canSeeFinance: boolean): Promise<EquipmentFileResponse[]> {
    const files: EquipmentFileResponse[] = [];
    for (const item of rows ?? []) {
      const mapped = await this.signedFile(asRow(item), canSeeFinance);
      if (mapped) files.push(mapped);
    }
    return files;
  }

  public async session(): Promise<ApiSessionUser> {
    const userId = await this.actorId();
    const { data, error } = await this.db()
      .from("users")
      .select("id, full_name, role, email, is_active, access_role_key, access_role:access_roles(key, name, base_role)")
      .eq("id", userId)
      .maybeSingle();
    throwIfError(error);
    if (!data) throw new M2ApiError(403, "Профиль пользователя не найден");
    const row = asRow(data);
    const accessRole = related(row, "access_role");
    const roleKey = optionalText(row, "access_role_key") ?? text(row, "role");
    const { data: permissionRows, error: permissionError } = await this.db()
      .from("access_role_permissions")
      .select("permission_code")
      .eq("role_key", roleKey);
    throwIfError(permissionError);
    return {
      id: text(row, "id"),
      fullName: text(row, "full_name"),
      role: optionalText(accessRole, "base_role") ?? text(row, "role"),
      accessRoleKey: roleKey,
      accessRoleName: optionalText(accessRole, "name"),
      permissions: (permissionRows ?? []).map((item) => text(asRow(item), "permission_code"))
    };
  }

  public async login(email: string, password: string): Promise<ApiSessionUser> {
    const { error } = await this.db().auth.signInWithPassword({ email, password });
    throwIfError(error, "Неверный e-mail или пароль");
    return this.session();
  }

  public async logout(): Promise<void> {
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
    const { data, error } = await this.db().from("users").select("id, full_name, role, email, is_active, access_role_key").order("full_name");
    throwIfError(error);
    return (data ?? []).map((item) => {
      const row = asRow(item);
      return {
        id: text(row, "id"),
        fullName: text(row, "full_name"),
        role: text(row, "role"),
        email: text(row, "email"),
        isActive: row.is_active !== false,
        accessRoleKey: optionalText(row, "access_role_key")
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
    return {
      id: userId,
      fullName: text(row, "full_name") || fullName,
      role: text(row, "role") || String(input.role ?? ""),
      email: text(row, "email") || email,
      isActive: row.is_active !== false,
      accessRoleKey: optionalText(row, "access_role_key") ?? accessRoleKey
    };
  }

  public async updateAccessUser(id: string, input: Readonly<Record<string, unknown>>): Promise<AccessUserRecord> {
    const patch: Row = {};
    if (input.fullName !== undefined) patch.full_name = input.fullName;
    if (input.role !== undefined) patch.role = input.role;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.accessRoleKey !== undefined) patch.access_role_key = input.accessRoleKey;
    const { data, error } = await this.db().from("users").update(patch).eq("id", id).select("id, full_name, role, email, is_active, access_role_key").single();
    throwIfError(error);
    const row = asRow(data);
    return {
      id: text(row, "id"),
      fullName: text(row, "full_name"),
      role: text(row, "role"),
      email: text(row, "email"),
      isActive: row.is_active !== false,
      accessRoleKey: optionalText(row, "access_role_key")
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
      const term = query.search.trim().replace(/[%_]/gu, "");
      if (term) request = request.or(`serial_number.ilike.%${term}%,notes.ilike.%${term}%`);
    }
    const { data, error, count } = await request;
    throwIfError(error);
    return paged((data ?? []).map((item) => mapEquipment(asRow(item))), count ?? 0, limit, offset);
  }

  /** Фильтр мог прийти id или отображаемым именем (старый Select без value). */
  private async resolveFilterId(
    table: "manufacturers" | "sites" | "payers",
    value: string | undefined
  ): Promise<string | undefined> {
    const raw = value?.trim();
    if (!raw) return undefined;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(raw)) return raw;
    const { data, error } = await this.db().from(table).select("id").ilike("name", raw).limit(1);
    throwIfError(error);
    const id = optionalText(asRow(data?.[0]), "id");
    return id;
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

  public async equipmentCard(id: string): Promise<EquipmentCardResponse> {
    const [passport, history, meterReadings, filesResult] = await Promise.all([
      this.loadEquipment(id),
      this.equipmentHistoryPage(id, 0, 25),
      this.equipmentMeterReadingsPage(id, 0, 25),
      this.db().from("files").select(FILE_SELECT).eq("equipment_id", id).order("created_at", { ascending: false })
    ]);
    throwIfError(filesResult.error);
    const session = await this.session();
    return {
      passport,
      history,
      meterReadings,
      files: await this.mapFiles(filesResult.data, session.permissions?.includes("finance.read") === true)
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
    return this.loadEquipment(text(asRow(data), "id"));
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
  ): Promise<unknown> {
    const actor = await this.actorId();
    const fn = kind === "site_change" ? "change_equipment_site" : "change_equipment_payer";
    const args = kind === "site_change"
      ? { p_equipment_id: id, p_new_site_id: input.targetId, p_happened_at: input.occurredAt, p_comment: input.comment, p_changed_by: actor }
      : { p_equipment_id: id, p_new_payer_id: input.targetId, p_happened_at: input.occurredAt, p_comment: input.comment, p_changed_by: actor };
    const { error } = await this.db().rpc(fn, args);
    throwIfError(error);
    return {};
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
      const key = `${id}/${crypto.randomUUID()}-${file.name}`;
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
    readonly siteId?: string;
    readonly workTypeCode?: string;
    readonly priority?: "urgent" | "planned";
    readonly periodFrom?: string;
    readonly periodTo?: string;
    readonly overdue?: boolean;
    readonly sort?: "deadline_asc" | "deadline_desc" | "updated_asc" | "updated_desc";
    readonly limit?: number;
    readonly offset?: number;
  } = {}): Promise<ApiPage<TaskApiRecord> & { readonly attention: { readonly new: number; readonly overdue: number; readonly underReview: number } }> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const ascending = query.sort === "deadline_asc" || query.sort === "updated_asc";
    const sortColumn = query.sort?.startsWith("deadline") ? "deadline_to" : "updated_at";
    let request = this.db().from("tasks").select(TASK_SELECT, { count: "exact" }).order(sortColumn, { ascending }).range(offset, offset + limit - 1);
    if (query.status) request = request.eq("status_code", query.status);
    if (query.engineerId) request = request.eq("engineer_id", query.engineerId);
    if (query.siteId) request = request.eq("site_id", query.siteId);
    if (query.workTypeCode) request = request.eq("work_type_code", query.workTypeCode);
    if (query.priority) request = request.eq("priority", query.priority);
    if (query.search?.trim()) request = request.or(`number.ilike.%${query.search.trim()}%,title.ilike.%${query.search.trim()}%`);
    const { data, error, count } = await request;
    throwIfError(error);
    const items = (data ?? []).map((item) => mapTask(asRow(item)));
    const { count: newCount } = await this.db().from("tasks").select("id", { count: "exact", head: true }).eq("status_code", "new");
    const { count: reviewCount } = await this.db().from("tasks").select("id", { count: "exact", head: true }).eq("status_code", "under_review");
    return {
      items,
      total: count ?? 0,
      limit,
      offset,
      attention: { new: newCount ?? 0, overdue: items.filter((item) => item.isOverdue).length, underReview: reviewCount ?? 0 }
    };
  }

  public async mailInbox(query: { readonly search?: string; readonly status?: string; readonly limit?: number; readonly offset?: number } = {}): Promise<MailInboxResponse> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    let request = this.db().from("mail_messages").select("id, sender, subject, received_at, status, ai_confidence, parsed_payload, task_id", { count: "exact" }).order("received_at", { ascending: false }).range(offset, offset + limit - 1);
    if (query.status) request = request.eq("status", query.status);
    if (query.search?.trim()) request = request.or(`sender.ilike.%${query.search.trim()}%,subject.ilike.%${query.search.trim()}%`);
    const { data, error, count } = await request;
    throwIfError(error);
    return {
      items: (data ?? []).map((item) => {
        const row = asRow(item);
        const payload = asRow(row.parsed_payload);
        return {
          id: text(row, "id"),
          sender: text(row, "sender"),
          subject: text(row, "subject"),
          receivedAt: iso(row.received_at),
          status: text(row, "status") as MailInboxRecord["status"],
          confidence: numberValue(row.ai_confidence),
          summary: optionalText(payload, "summary"),
          equipmentSerial: optionalText(payload, "equipmentSerial"),
          workTypeCode: optionalText(payload, "workTypeCode"),
          taskId: optionalText(row, "task_id")
        };
      }),
      total: count ?? 0,
      limit,
      offset
    };
  }

  public async updateMailInbox(id: string, input: { readonly status: "pending" | "ignored" | "converted"; readonly taskId?: string }): Promise<MailInboxRecord> {
    const { data, error } = await this.db().from("mail_messages").update({
      status: input.status,
      task_id: input.taskId ?? null
    }).eq("id", id).select("id, sender, subject, received_at, status, ai_confidence, parsed_payload, task_id").single();
    throwIfError(error);
    const row = asRow(data);
    return {
      id: text(row, "id"),
      sender: text(row, "sender"),
      subject: text(row, "subject"),
      receivedAt: iso(row.received_at),
      status: text(row, "status") as MailInboxRecord["status"],
      taskId: optionalText(row, "task_id")
    };
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
        equipment: { id: task.equipmentId ?? "", serialNumber: "", manufacturer: "", model: "" },
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
    const { data, error } = await this.db().from("tasks").insert({
      title: input.title,
      work_type_code: String(input.workTypeCode || "diagnostics"),
      priority: input.priority ?? "planned",
      is_maintenance_plan: input.isMaintenancePlan === true,
      maintenance_plan_id: input.maintenancePlanId ?? null,
      equipment_id: input.equipmentId,
      site_id: siteId,
      site_contact_id: input.siteContactId ?? null,
      payer_id: payerId,
      engineer_id: input.engineerId ?? null,
      deadline_from: input.periodFrom ?? null,
      deadline_to: input.periodTo ?? null,
      call_date: input.callDate ?? new Date().toISOString().slice(0, 10),
      visit_date: input.visitDate ?? null,
      created_by: actor,
      ...(input.payerOverrideReason ? {
        payer_override_reason: input.payerOverrideReason,
        payer_overridden_by: actor
      } : {})
    }).select("id").single();
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
  }): Promise<TaskCardResponse> {
    const { error } = await this.db().from("tasks").update({
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
      const key = `tasks/${id}/${crypto.randomUUID()}-${file.name}`;
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
    const task = await this.loadTask(id);
    const session = await this.session();
    const canSeeFinance = session.permissions?.includes("finance.read") === true;
    const [parts, files, journal, engineer, workType, reason, closure, statusRow] = await Promise.all([
      this.db().from("task_parts").select("id, article_number_snapshot, name_snapshot, quantity, part_condition").eq("task_id", id).order("position"),
      this.db().from("files").select(FILE_SELECT).eq("task_id", id).order("created_at"),
      this.db().from("task_status_history").select("id, from_status, to_status, comment, changed_at, changed_by").eq("task_id", id).order("changed_at", { ascending: false }),
      task.engineerId ? this.db().from("users").select("id, full_name").eq("id", task.engineerId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      task.workTypeCode ? this.db().from("work_types").select("code, name").eq("code", task.workTypeCode).maybeSingle() : Promise.resolve({ data: null, error: null }),
      task.reasonCode ? this.db().from("task_reasons").select("code, name").eq("code", task.reasonCode).maybeSingle() : Promise.resolve({ data: null, error: null }),
      this.db().from("task_closures").select("task_id, act_file_id, submitted_by, submitted_at, verified_by, verified_at, verification_comment").eq("task_id", id).maybeSingle(),
      this.db().from("task_statuses").select("code, name").eq("code", task.status).maybeSingle()
    ]);
    throwIfError(parts.error);
    throwIfError(files.error);
    throwIfError(journal.error);
    throwIfError(engineer.error);
    throwIfError(workType.error);
    throwIfError(reason.error);
    throwIfError(closure.error);
    throwIfError(statusRow.error);
    const closureRow = closure.data ? asRow(closure.data) : undefined;
    const submitterId = closureRow ? optionalText(closureRow, "submitted_by") : undefined;
    const submitter = submitterId
      ? await this.db().from("users").select("full_name").eq("id", submitterId).maybeSingle()
      : { data: null, error: null };
    throwIfError(submitter.error);
    const actorIds = [...new Set((journal.data ?? []).map((item) => optionalText(asRow(item), "changed_by")).filter((value): value is string => Boolean(value)))];
    const actors = actorIds.length
      ? await this.db().from("users").select("id, full_name").in("id", actorIds)
      : { data: [], error: null };
    throwIfError(actors.error);
    const actorNameById = new Map((actors.data ?? []).map((item) => [text(asRow(item), "id"), text(asRow(item), "full_name")]));
    const mappedFiles = await this.mapFiles(files.data, canSeeFinance);
    const canWrite = session.permissions?.includes("tasks.write") === true || session.permissions?.includes("tasks.write_own") === true;
    const terminal = ["closed", "cancelled"].includes(task.status);
    return {
      task,
      equipment: task.equipmentId ? await this.loadEquipment(task.equipmentId) : undefined,
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
          condition: text(row, "part_condition") as TaskPartPosition["condition"]
        };
      }),
      canEditOverview: !terminal && canWrite,
      canEditParts: !terminal && canWrite,
      canUploadFiles: !terminal && session.permissions?.includes("files.write") === true,
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
      const { error } = await this.db().from("task_parts").insert(items.map((item, index) => {
        const partId = partIdByArticle.get(item.articleNumber);
        if (!partId) throw new M2ApiError(400, `Номенклатура ${item.articleNumber} не найдена`);
        return {
          task_id: id,
          part_id: partId,
          part_condition: item.condition,
          article_number_snapshot: item.articleNumber,
          name_snapshot: item.name,
          quantity: item.quantity,
          position: index
        };
      }));
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
    const { data, error } = await this.db().from("users").select("id, full_name, is_active, engineer_competencies(model_line, manufacturer:manufacturers(name))").eq("role", "engineer").order("full_name");
    throwIfError(error);
    const engineers = data ?? [];
    const { data: tasks, error: taskError } = await this.db().from("tasks").select("engineer_id, status_code, deadline_to").not("engineer_id", "is", null);
    throwIfError(taskError);
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
      const withEngineersQuantity = 0;
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
      withEngineersQuantity: 0,
      belowMinimum: availableQuantity < minimumStock
    };
  }

  public async operationsReport(from: string, to: string): Promise<OperationsReportRecord> {
    const [{ data, error }, workTypesResult] = await Promise.all([
      this.db().from("tasks").select("status_code, work_type_code, deadline_to, completed_at, created_at").gte("created_at", from).lte("created_at", `${to}T23:59:59.999Z`),
      this.db().from("work_types").select("code, name")
    ]);
    throwIfError(error);
    const tasks = data ?? [];
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
      const created = (optionalText(row, "created_at") ?? iso(row.created_at)).slice(0, 7);
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      byType.set(type, (byType.get(type) ?? 0) + 1);
      if (/^\d{4}-\d{2}$/u.test(created)) byMonth.set(created, (byMonth.get(created) ?? 0) + 1);
      if (status === "closed") {
        const deadline = optionalText(row, "deadline_to")?.slice(0, 10);
        const completed = (optionalText(row, "completed_at") ?? iso(row.completed_at)).slice(0, 10);
        if (deadline) {
          datedClosed += 1;
          if (completed && completed <= deadline) onTimeClosed += 1;
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
          const deadline = optionalText(row, "deadline_to");
          return Boolean(deadline && deadline < to && !["closed", "cancelled"].includes(text(row, "status_code")));
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

  public async assignTask(id: string, engineerId: string, _comment?: string): Promise<TaskApiRecord> {
    const { error } = await this.db().from("tasks").update({ engineer_id: engineerId, status_code: "assigned" }).eq("id", id);
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
    const { data, error } = await this.db().from("invoices").insert({
      payer_id: input.payerId,
      status: "draft"
    }).select("id").single();
    throwIfError(error);
    const invoiceId = text(asRow(data), "id");
    if (taskIds.length) {
      const { error: itemsError } = await this.db().from("invoice_tasks").insert(taskIds.map((taskId) => ({ invoice_id: invoiceId, task_id: taskId })));
      throwIfError(itemsError);
    }
    const invoices = await this.listInvoices();
    const created = invoices.find((item) => item.id === invoiceId);
    if (!created) throw new M2ApiError(500, "Счёт не создан");
    return created;
  }

  public async listCatalogs(): Promise<readonly ReferenceCatalogDescriptor[]> {
    return CATALOGS;
  }

  public async listCatalogValues(key: string): Promise<readonly ReferenceCatalogValue[]> {
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
    throwIfError(error);
    const values = await this.listCatalogValues(key);
    const created = values.find((item) => item.name === input.name);
    if (!created) throw new M2ApiError(500, "Значение справочника не создано");
    return created;
  }

  public async updateCatalogValue(key: string, id: string, input: Readonly<Record<string, unknown>>): Promise<ReferenceCatalogValue> {
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    const patch: Row = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    if (input.attributes !== undefined) applyCatalogAttributes(patch, asRow(input.attributes));
    const { error } = await this.db().from(catalog.table).update(patch).eq(catalog.id, id);
    throwIfError(error);
    const values = await this.listCatalogValues(key);
    const updated = values.find((item) => item.id === id);
    if (!updated) throw new M2ApiError(404, "Значение справочника не найдено");
    return updated;
  }

  public async moveCatalogValue(key: string, id: string, direction: "up" | "down"): Promise<readonly ReferenceCatalogValue[]> {
    const catalog = CATALOG_TABLE[key];
    if (!catalog) throw new M2ApiError(404, "Справочник не найден");
    const values = [...await this.listCatalogValues(key)];
    const index = values.findIndex((item) => item.id === id);
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= values.length) return values;
    const [moved] = values.splice(index, 1);
    if (!moved) return values;
    values.splice(target, 0, moved);
    const results = await Promise.all(values.map((item, position) =>
      this.db().from(catalog.table).update({ sort_order: (position + 1) * 10 }).eq(catalog.id, item.id)
    ));
    for (const result of results) throwIfError(result.error);
    return this.listCatalogValues(key);
  }

  public async removeCatalogValue(key: string, id: string): Promise<{ readonly mode: "deactivated" | "deleted"; readonly after?: ReferenceCatalogValue }> {
    const after = await this.updateCatalogValue(key, id, { isActive: false });
    return { mode: "deactivated", after };
  }
}

export const m2Api = new M2ApiClient();
