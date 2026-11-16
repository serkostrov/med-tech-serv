/**
 * Подписи к движениям склада и остаткам по состояниям. Что именно записано в движении,
 * решает база (миграции 0022, 0028, 0048, 0049, 0050); здесь только слова для экрана.
 */
import type { PartConditionTotals, StockMovementRecord, StockMovementType } from "./m2-api.js";
import type { StatusTone } from "./ui.js";
import { companyDateTimeText } from "./task-dates.js";
import { formatRussianCount } from "./equipment-changes.js";

export type PartCondition = "G" | "N" | "B";

/** Состояния в том порядке, в каком их показывают на складе: Г, Н, Б. */
export const PART_CONDITIONS: readonly PartCondition[] = ["G", "N", "B"];

/** Буква состояния для узкой колонки списка. */
export const PART_CONDITION_LETTERS: Readonly<Record<PartCondition, string>> = { G: "Г", N: "Н", B: "Б" };

/** Состояние словом про одну запчасть: «гарантийная лампа». */
export const PART_CONDITION_LABELS: Readonly<Record<PartCondition, string>> = {
  G: "гарантийная",
  N: "новая",
  B: "б/у"
};

/** Состояние словом про остаток: «1 гарантийная», «4 гарантийных» — считаем по-русски. */
export const PART_CONDITION_FORMS: Readonly<Record<PartCondition, readonly [string, string, string]>> = {
  G: ["гарантийная", "гарантийные", "гарантийных"],
  N: ["новая", "новые", "новых"],
  B: ["б/у", "б/у", "б/у"]
};

export const MOVEMENT_LABELS: Readonly<Record<StockMovementType, string>> = {
  receipt: "Приход",
  reserve: "Резерв",
  issue: "Выдача",
  install: "Установка",
  writeoff: "Списание",
  return: "Возврат",
  adjustment: "Корректировка"
};

/** Цвет метки движения: приход и возврат добавляют, выдача и списание убавляют. */
export const MOVEMENT_TONES: Readonly<Record<StockMovementType, StatusTone>> = {
  receipt: "success",
  reserve: "warning",
  issue: "purple",
  install: "info",
  writeoff: "danger",
  return: "success",
  adjustment: "orange"
};

/** Количество как в резервах: целое со «шт.», дробное через запятую (метры трубки). */
export function movementQuantityText(quantity: number): string {
  return Number.isInteger(quantity) ? `${quantity} шт.` : String(quantity).replace(".", ",");
}

/**
 * Насколько изменился остаток: «+5», «−2» или «0» у резерва и установки — они
 * переставляют запчасть внутри склада, а остаток не меняют. Минус настоящий (−), а не дефис.
 */
export function movementDeltaText(delta: number): string {
  if (delta === 0) return "0";
  const amount = String(Math.abs(delta)).replace(".", ",");
  return `${delta > 0 ? "+" : "−"}${amount}`;
}

/** К чему движение относится: задача, резерв, прибор. Пусто — приход, списание, корректировка. */
export function movementTargetText(movement: Pick<StockMovementRecord, "taskNumber" | "reservationNumber" | "equipmentSerialNumber">): string {
  return [
    movement.taskNumber ? `задача ${movement.taskNumber}` : "",
    movement.reservationNumber ? `резерв ${movement.reservationNumber}` : "",
    movement.equipmentSerialNumber ? `прибор ${movement.equipmentSerialNumber}` : ""
  ].filter(Boolean).join(" · ");
}

/** «14.11.2026 09:30 · Никитина Ольга Павловна». Без автора — только время. */
export function movementWhenText(movement: Pick<StockMovementRecord, "occurredAt" | "actorName">): string {
  return [companyDateTimeText(movement.occurredAt), movement.actorName].filter(Boolean).join(" · ");
}

/**
 * Остаток по состояниям для списка: «4 Г · 11 Н». Нули не пишем — в колонке важно,
 * чего сколько есть. Совсем пусто — прочерк: ни в одном состоянии ничего нет.
 */
export function conditionTotalsText(totals: PartConditionTotals): string {
  const parts = PART_CONDITIONS
    .filter((condition) => totals[condition] > 0)
    .map((condition) => `${String(totals[condition]).replace(".", ",")} ${PART_CONDITION_LETTERS[condition]}`);
  return parts.length ? parts.join(" · ") : "—";
}

/** То же для подсказки словами: «4 гарантийных, 11 новых». Пусто — «ни в одном состоянии нет». */
export function conditionTotalsTitle(totals: PartConditionTotals): string {
  const parts = PART_CONDITIONS
    .filter((condition) => totals[condition] > 0)
    // Дробное количество (метры трубки) в склонение не отдаём: «2,5 новых» ни одна форма
    // не описывает, а formatRussianCount считает по целым.
    .map((condition) => Number.isInteger(totals[condition])
      ? formatRussianCount(totals[condition], PART_CONDITION_FORMS[condition])
      : `${String(totals[condition]).replace(".", ",")} ${PART_CONDITION_FORMS[condition][2]}`);
  return parts.length ? parts.join(", ") : "ни в одном состоянии нет";
}

/**
 * Какие состояния предлагать для списания и корректировки. Списать можно только то,
 * что лежит на складе, поэтому пустые состояния в выборе списания не нужны; при
 * корректировке нужны все — ненайденный в учёте остаток как раз и приходуют ею.
 */
export function conditionsWithStock(totals: PartConditionTotals): readonly PartCondition[] {
  return PART_CONDITIONS.filter((condition) => totals[condition] > 0);
}

/**
 * Какое состояние подставить в форму: где сейчас больше доступного. Иначе в списании
 * по умолчанию оказывалось бы первое по порядку (Г), даже когда всё гарантийное
 * разобрано под задачи, и человек видел бы отказ на пустом месте.
 */
export function conditionWithMostStock(totals: PartConditionTotals, fallback: PartCondition = "N"): PartCondition {
  let best: PartCondition | undefined;
  for (const condition of PART_CONDITIONS) {
    if (totals[condition] > 0 && (!best || totals[condition] > totals[best])) best = condition;
  }
  return best ?? fallback;
}
