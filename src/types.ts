import type { Permission, WorkingRole } from "./domain/access.js";
import type { EquipmentHistoryEvent } from "./domain/equipment-history.js";
import type { MaintenancePlanStatus, MaintenanceTimelineSegment } from "./domain/maintenance-plan.js";

export type { Permission, WorkingRole } from "./domain/access.js";
export type { EquipmentHistoryEvent, EquipmentHistoryEventType } from "./domain/equipment-history.js";
export {
  createManualEquipmentHistoryEvent,
  sortEquipmentHistory
} from "./domain/equipment-history.js";
export {
  assertAnnualMaintenancePlan,
  MAX_ANNUAL_MAINTENANCE_PERIODS,
  maintenancePeriodOnYearTimeline
} from "./domain/maintenance-plan.js";

export type NotificationDeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "failed" | "cancelled";

export interface NotificationJournalRecord {
  readonly id: string;
  readonly eventCode: string;
  readonly recipientUserId?: string;
  readonly channel: "email" | "telegram" | "max" | "sms";
  readonly recipientAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly status: NotificationDeliveryStatus;
  readonly scheduledAt: string;
  readonly sentAt?: string;
  readonly deliveredAt?: string;
  readonly attempts: number;
  readonly lastError?: string;
  readonly diagnosticError?: string;
  readonly taskId?: string;
  readonly createdAt: string;
}

export interface NotificationJournalResponse {
  readonly items: readonly NotificationJournalRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
}

export type MailInboxStatus = "pending" | "parsed" | "converted" | "ignored" | "failed";

export interface MailInboxRecord {
  readonly id: string;
  readonly sender: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly status: MailInboxStatus;
  readonly confidence?: number;
  readonly summary?: string;
  readonly equipmentSerial?: string;
  readonly workTypeCode?: string;
  readonly taskId?: string;
  /** Что разобрала служба из письма (может быть пусто или неточно). */
  readonly client?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
  readonly equipmentName?: string;
  readonly equipmentFound?: boolean;
  readonly equipmentId?: string;
  readonly equipmentLabel?: string;
  readonly description?: string;
  readonly lowConfidence?: boolean;
  readonly body?: string;
  readonly rawStorageKey?: string;
  /** Служба уже разбирала письмо (для «Вернуть в работу»). */
  readonly wasParsed?: boolean;
  readonly autoreplySent?: boolean;
  readonly autoreplyError?: string;
  readonly attachments?: readonly MailAttachment[];
}

export interface MailAttachment {
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface MailInboxResponse {
  readonly items: readonly MailInboxRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number;
}

export interface NotificationTemplateResponse {
  readonly code: string;
  readonly name: string;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly allowedVariables: readonly string[];
  readonly isActive: boolean;
  readonly updatedAt: string;
}

export interface UpdateNotificationTemplateRequest {
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly isActive: boolean;
}

export type TaskStatus =
  | "planned"
  | "new"
  | "assigned"
  | "in_progress"
  | "under_review"
  | "closed"
  | "cancelled";

export type TaskPriority = "urgent" | "planned";
export type { AvailableTaskAction } from "./domain/task-actions.js";
export type { TaskActionCode } from "./domain/task-actions.js";

export interface EngineerTaskListItem {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority?: TaskPriority;
  readonly isNew: boolean;
  readonly isOverdue: boolean;
  readonly site: { readonly name: string; readonly address: string };
  readonly equipment: {
    readonly id: string;
    readonly serialNumber: string;
    readonly manufacturer: string;
    readonly model: string;
  };
  readonly dates: {
    readonly call?: string;
    readonly periodFrom?: string;
    readonly periodTo?: string;
    readonly visit?: string;
  };
}

export interface EngineerTaskListResponse {
  readonly items: readonly EngineerTaskListItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface TaskPartPosition {
  readonly id: string;
  readonly articleNumber: string;
  readonly name: string;
  readonly quantity: number;
  readonly condition: "G" | "N" | "B";
  readonly forSale?: boolean;
  /**
   * Позиция собрана складом из резервов (миграция 0028): её нельзя править руками.
   * Строка одна на запчасть и состояние, количество в ней — сумма отмеченных резервов,
   * а reservationId — любой из них, поэтому за подробностями идём в сами резервы.
   */
  readonly reservationId?: string;
}

export interface TaskPartsResponse {
  readonly items: readonly TaskPartPosition[];
}

export interface BulkTaskCommandResponse {
  readonly operation: "assignment" | "period_change";
  readonly requestedCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly succeededTaskIds: readonly string[];
  readonly failures: readonly {
    readonly taskId: string;
    readonly code: "conflict" | "invalid_status" | "not_found";
    readonly error: string;
  }[];
}

export interface MaintenancePlanPeriodResponse {
  readonly id: string;
  readonly equipmentId: string;
  readonly year: number;
  readonly periodNo: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly status: MaintenancePlanStatus;
  readonly assignedEngineerId?: string;
  readonly assignedEngineerName?: string;
  readonly comment?: string;
  readonly generatedTaskId?: string;
  readonly equipment: { readonly serialNumber: string; readonly manufacturer: string; readonly model: string };
  readonly organizationId?: string;
  readonly organization?: string;
  readonly siteId?: string;
  readonly site?: string;
  readonly timeline: MaintenanceTimelineSegment;
}

export interface MaintenancePlanListResponse {
  readonly year: number;
  readonly view: "equipment" | "engineer" | "organization";
  readonly items: readonly MaintenancePlanPeriodResponse[];
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly items: readonly MaintenancePlanPeriodResponse[];
  }[];
}

export interface ReplaceAnnualMaintenancePlanRequest {
  readonly equipmentId: string;
  readonly year: number;
  readonly periods: readonly {
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly assignedEngineerId?: string;
    readonly comment?: string;
  }[];
}

export interface GenerateMaintenanceTasksResponse {
  readonly requestedCount: number;
  readonly created: readonly { readonly planId: string; readonly taskId: string }[];
  readonly existing: readonly { readonly planId: string; readonly taskId: string }[];
  readonly failures: readonly {
    readonly planId: string;
    readonly code: "invalid_status" | "missing_relation" | "not_found";
    readonly error: string;
  }[];
}

export interface EquipmentFileResponse {
  readonly id: string;
  readonly kind: string;
  readonly equipmentId?: string;
  readonly originalName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly url?: string;
  /** Ключ в хранилище: по нему галерея получает ссылку, если её ещё нет. */
  readonly storageKey?: string;
}

export interface EquipmentMeterReading {
  readonly id: string;
  readonly equipmentId: string;
  readonly value: number;
  readonly reading: number;
  readonly recordedAt: string;
  readonly measuredAt: string;
  readonly taskId?: string;
  readonly author: { readonly id?: string; readonly name: string };
}

export interface AccessRoleResponse {
  readonly key: string;
  readonly name: string;
  readonly baseRole: WorkingRole;
  readonly permissions: readonly Permission[];
  readonly builtIn: boolean;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
