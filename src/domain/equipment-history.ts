export const EQUIPMENT_HISTORY_EVENT_TYPES = [
  "task",
  "part_replacement",
  "site_change",
  "payer_change",
  "attachment",
  "imported",
  "manual",
  "meter"
] as const;

export type EquipmentHistoryEventType = typeof EQUIPMENT_HISTORY_EVENT_TYPES[number];

export interface EquipmentHistoryValue {
  readonly id?: string;
  readonly name: string;
}

export interface EquipmentHistoryAuthor {
  readonly id?: string;
  readonly name: string;
}

export interface EquipmentHistorySource {
  readonly kind: EquipmentHistoryEventType;
  readonly id?: string;
}

export interface EquipmentHistoryAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly contentType?: string;
}

/**
 * Единый формат записи ленты прибора. `description` намеренно обязателен:
 * пустая строка означает пустое исходное описание и не подменяется служебным
 * текстом. Клиент хранится снимком на момент события.
 */
export interface EquipmentHistoryEvent {
  readonly id: string;
  readonly equipmentId: string;
  readonly occurredAt: string;
  readonly recordedAt?: string;
  readonly eventType: EquipmentHistoryEventType;
  readonly summary: string;
  readonly client: string;
  readonly description: string;
  readonly source: EquipmentHistorySource;
  readonly taskId?: string;
  readonly previousValue?: EquipmentHistoryValue;
  readonly newValue?: EquipmentHistoryValue;
  readonly comment?: string;
  readonly author?: EquipmentHistoryAuthor;
  readonly attachment?: EquipmentHistoryAttachment;
}

export interface NewManualEquipmentHistoryEvent {
  readonly id: string;
  readonly equipmentId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly client: string;
  readonly description: string;
  readonly author: EquipmentHistoryAuthor;
  readonly recordedAt?: string;
}

function eventTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Поле ${field} должно содержать корректную дату`);
  return parsed;
}

export function sortEquipmentHistory(
  events: readonly EquipmentHistoryEvent[]
): readonly EquipmentHistoryEvent[] {
  return [...events].sort((left, right) => (
    eventTimestamp(String(right.occurredAt), "occurredAt") - eventTimestamp(String(left.occurredAt), "occurredAt")
    || eventTimestamp(String(right.recordedAt ?? right.occurredAt), "recordedAt")
      - eventTimestamp(String(left.recordedAt ?? left.occurredAt), "recordedAt")
    || right.id.localeCompare(left.id, "en")
  ));
}

/** Создаёт ручное событие, сохраняя исходное описание без trim/усечения. */
export function createManualEquipmentHistoryEvent(
  input: NewManualEquipmentHistoryEvent
): EquipmentHistoryEvent {
  const occurredAt = new Date(eventTimestamp(input.occurredAt, "occurredAt")).toISOString();
  const summary = input.summary.trim();
  const client = input.client.trim();
  if (!summary) throw new Error("Название исторического события обязательно");
  if (summary.length > 200) throw new Error("Название исторического события не должно превышать 200 символов");
  if (!client) throw new Error("Клиент исторического события обязателен");
  if (client.length > 500) throw new Error("Название клиента не должно превышать 500 символов");
  if (input.description.length > 50_000) {
    throw new Error("Описание исторического события не должно превышать 50000 символов");
  }
  return {
    id: input.id,
    equipmentId: input.equipmentId,
    occurredAt,
    ...(input.recordedAt ? { recordedAt: new Date(eventTimestamp(input.recordedAt, "recordedAt")).toISOString() } : {}),
    eventType: "manual",
    summary,
    client,
    description: input.description,
    source: { kind: "manual", id: input.id },
    author: { ...input.author }
  };
}
