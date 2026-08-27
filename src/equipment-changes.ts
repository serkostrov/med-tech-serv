import { sortEquipmentHistory, type EquipmentHistoryEvent } from "./domain/equipment-history.js";
import { formatDisplayDate } from "./date-format.js";

export type EquipmentAssignmentKind = "site_change" | "payer_change";

export type EquipmentAssignmentHistoryEvent = EquipmentHistoryEvent & {
  readonly eventType: EquipmentAssignmentKind;
  readonly previousValue: { readonly id?: string; readonly name: string };
  readonly newValue: { readonly id?: string; readonly name: string };
  readonly comment: string;
};

export interface EquipmentAssignmentState {
  readonly id: string;
  readonly siteId: string;
  readonly place: string;
  readonly payerId: string;
  readonly payer: string;
  readonly history: readonly EquipmentHistoryEvent[];
}

export interface NewEquipmentAssignmentChange {
  readonly kind: EquipmentAssignmentKind;
  readonly targetId: string;
  readonly targetName: string;
  readonly occurredAt: string;
  readonly comment: string;
  readonly author?: string;
  readonly id?: string;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Укажите корректную дату операции");
  return parsed;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** Значение для datetime-local в локальной зоне пользователя, без UTC-сдвига полей формы. */
export function localDateTimeInputValue(value = new Date()): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Укажите корректную дату операции");
  return `${value.getFullYear()}-${twoDigits(value.getMonth() + 1)}-${twoDigits(value.getDate())}`
    + `T${twoDigits(value.getHours())}:${twoDigits(value.getMinutes())}`;
}

/** Превращает стенное время datetime-local в однозначный UTC-момент до отправки API. */
export function localDateTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!match) throw new Error("Укажите корректную дату и время");
  const [, year, month, day, hour, minute, second] = match;
  const local = new Date(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? 0), 0
  );
  if (!Number.isFinite(local.getTime())
    || local.getFullYear() !== Number(year)
    || local.getMonth() !== Number(month) - 1
    || local.getDate() !== Number(day)
    || local.getHours() !== Number(hour)
    || local.getMinutes() !== Number(minute)) {
    throw new Error("Укажите существующие дату и время");
  }
  return local.toISOString();
}

/**
 * Формирует новое текущее значение и событие одной неделимой операцией состояния.
 * Серверный адаптер применяет тот же контракт внутри транзакции PostgreSQL.
 */
export function applyEquipmentAssignmentChange(
  state: EquipmentAssignmentState,
  input: NewEquipmentAssignmentChange
): EquipmentAssignmentState {
  if (!input.author?.trim()) throw new Error("Для локального события нужно указать автора");
  const comment = input.comment.trim();
  if (!comment) throw new Error("Комментарий операции обязателен");
  const occurredAt = new Date(timestamp(input.occurredAt)).toISOString();
  const currentId = input.kind === "site_change" ? state.siteId : state.payerId;
  const currentName = input.kind === "site_change" ? state.place : state.payer;
  if (currentId === input.targetId) throw new Error("Новое значение совпадает с текущим");
  const latest = state.history
    .filter((event) => event.eventType === input.kind)
    .reduce<number | undefined>((value, event) => {
      const eventAt = timestamp(event.occurredAt);
      return value === undefined || eventAt > value ? eventAt : value;
    }, undefined);
  if (latest !== undefined && timestamp(occurredAt) <= latest) {
    throw new Error("Дата операции должна быть позже последней записи этого вида");
  }
  const event: EquipmentAssignmentHistoryEvent = {
    id: input.id ?? `change-${input.kind}-${occurredAt}`,
    equipmentId: state.id,
    eventType: input.kind,
    occurredAt,
    summary: `${input.kind === "site_change" ? "Место установки" : "Плательщик"}: «${currentName}» → «${input.targetName}»`,
    client: input.kind === "site_change" ? input.targetName : state.place,
    description: comment,
    source: { kind: input.kind, id: input.id ?? `change-${input.kind}-${occurredAt}` },
    previousValue: { ...(currentId ? { id: currentId } : {}), name: currentName },
    newValue: { id: input.targetId, name: input.targetName },
    comment,
    author: { name: input.author.trim() }
  };
  const history = sortEquipmentHistory([...state.history, event]);
  return input.kind === "site_change"
    ? { ...state, siteId: input.targetId, place: input.targetName, history }
    : { ...state, payerId: input.targetId, payer: input.targetName, history };
}

export function formatEquipmentAssignmentDate(value: string): string {
  timestamp(value);
  return formatDisplayDate(value, true);
}

/** Склонение счётчика: 1 запись, 2 записи, 5 записей. */
export function formatRussianCount(count: number, forms: readonly [string, string, string]): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  const word = n > 10 && n < 20 ? forms[2] : n1 === 1 ? forms[0] : n1 >= 2 && n1 <= 4 ? forms[1] : forms[2];
  return `${count} ${word}`;
}

function isUnsetAssignmentName(value: string): boolean {
  return !value.trim() || /^не указан/iu.test(value.trim());
}

/** Заголовок смены места/плательщика без ложного «Не указано → Не указано». */
export function formatEquipmentAssignmentChange(event: EquipmentHistoryEvent): string {
  const previous = event.previousValue?.name?.trim() ?? "";
  const next = event.newValue?.name?.trim() ?? "";
  if (!isUnsetAssignmentName(previous) && !isUnsetAssignmentName(next)) return `${previous} → ${next}`;
  if (isUnsetAssignmentName(previous) && !isUnsetAssignmentName(next)) return next;
  if (!isUnsetAssignmentName(previous) && isUnsetAssignmentName(next)) return `${previous} → не указано`;
  const summary = event.summary.trim();
  return summary || "Изменение не указано";
}
