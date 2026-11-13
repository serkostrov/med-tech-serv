import {
  createManualEquipmentHistoryEvent,
  sortEquipmentHistory,
  type EquipmentHistoryEvent,
  type EquipmentHistoryEventType
} from "./domain/equipment-history.js";

const EVENT_LABELS: Readonly<Record<EquipmentHistoryEventType, string>> = {
  task: "Задача",
  part_replacement: "Замена запчасти",
  site_change: "Место установки",
  payer_change: "Плательщик",
  attachment: "Вложение",
  imported: "Импорт",
  manual: "Ручная запись",
  meter: "Показание счётчика"
};

export interface ManualEquipmentHistoryDraft {
  readonly occurredAt: string;
  readonly summary: string;
  readonly client: string;
  readonly description: string;
  readonly author?: string;
  readonly id?: string;
  readonly recordedAt?: string;
}

export function equipmentHistoryEventLabel(type: EquipmentHistoryEventType): string {
  return EVENT_LABELS[type];
}

const PART_CONDITION_LABELS: Readonly<Record<"G" | "N" | "B", string>> = {
  G: "Г, гарантийная",
  N: "Н, новая",
  B: "Б, б/у"
};

/**
 * Что поставили на прибор: «AU-LAMP-12V20W Лампа галогеновая, 2 шт., Н, новая».
 * У старых событий замены подробностей нет — тогда остаётся прежний заголовок.
 */
export function equipmentHistoryPartText(event: Pick<EquipmentHistoryEvent, "part">): string | undefined {
  const part = event.part;
  if (!part) return undefined;
  const quantity = part.quantity === undefined ? undefined
    : Number.isInteger(part.quantity) ? `${part.quantity} шт.` : `${String(part.quantity).replace(".", ",")} шт.`;
  const line = [
    [part.articleNumber, part.name].filter(Boolean).join(" "),
    quantity,
    part.condition ? PART_CONDITION_LABELS[part.condition] : undefined
  ].filter(Boolean).join(", ");
  return line || undefined;
}

export function equipmentHistoryDescription(event: EquipmentHistoryEvent): string {
  return event.description || "Описание не указано";
}

export function addManualEquipmentHistory(
  events: readonly EquipmentHistoryEvent[],
  equipmentId: string,
  draft: ManualEquipmentHistoryDraft
): readonly EquipmentHistoryEvent[] {
  if (!draft.author?.trim()) throw new Error("Для локального события нужно указать автора");
  const id = draft.id ?? `manual-${equipmentId}-${Date.now()}`;
  const event = createManualEquipmentHistoryEvent({
    id,
    equipmentId,
    occurredAt: draft.occurredAt,
    summary: draft.summary,
    client: draft.client,
    description: draft.description,
    author: { name: draft.author.trim() },
    ...(draft.recordedAt ? { recordedAt: draft.recordedAt } : {})
  });
  return sortEquipmentHistory([...events, event]);
}
