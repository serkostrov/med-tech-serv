export type ReferenceAttributeValue = string | number | boolean | null;

/** Значение справочника в объёме, нужном для запрета отключения. */
export interface HideableReferenceValue {
  readonly name: string;
  readonly isBuiltin?: boolean;
}

/**
 * Можно ли скрыть значение справочника.
 * Встроенные этапы задачи, статусы приборов и виды работ держат работу базы: без этапа
 * «Закрыта» задачи перестают закрываться по всей системе. База такие значения не отключает
 * (миграция 0033), интерфейс не рисует у них кнопку «Скрыть».
 */
export function canHideReferenceValue(value: HideableReferenceValue): boolean {
  return value.isBuiltin !== true;
}

/** Тот же запрет словами: отказ до запроса к базе, чтобы человек не ждал ответа. */
export function assertReferenceValueCanBeHidden(value: HideableReferenceValue): void {
  if (!canHideReferenceValue(value)) {
    throw new Error(`«${value.name}» — встроенное значение справочника: на нём держится работа системы. Отключить его нельзя`);
  }
}

/** Формирует полный PATCH справочника, не теряя поля, скрытые в таблице. */
export function referenceEditPayload(
  name: string,
  attributes: Readonly<Record<string, ReferenceAttributeValue>>
): { readonly name: string; readonly attributes: Readonly<Record<string, ReferenceAttributeValue>> } {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Наименование обязательно");
  return { name: normalizedName, attributes: { ...attributes } };
}
