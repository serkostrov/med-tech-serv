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

export interface ExistingReferenceValue {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly attributes: Readonly<Record<string, ReferenceAttributeValue>>;
}

/**
 * Дубль модели прибора у одного производителя.
 *
 * База дубль не примет (индекс из 0001, объяснение в 0039), но человеку надо сказать до
 * запроса, а не показывать ожидание и сырую ошибку. Регистр и лишние пробелы не считаются
 * различием — так же, как в базе и в проверке серийного номера прибора.
 */
export function duplicateModelRefusal(
  draft: { readonly id?: string; readonly name: string; readonly manufacturerId: ReferenceAttributeValue },
  existing: readonly ExistingReferenceValue[],
  manufacturerName?: string
): string | null {
  const name = draft.name.trim().toLocaleLowerCase("ru-RU");
  if (!name || !draft.manufacturerId) return null;
  const clash = existing.find((item) => item.id !== draft.id
    && item.attributes.manufacturerId === draft.manufacturerId
    && item.name.trim().toLocaleLowerCase("ru-RU") === name);
  if (!clash) return null;
  const maker = manufacturerName ? ` у производителя «${manufacturerName}»` : "";
  const hidden = clash.isActive ? "" : ", но скрыта: верните её кнопкой «Показать»";
  return `Модель «${draft.name.trim()}»${maker} уже есть в справочнике${hidden}. Регистр и пробелы при проверке не учитываются`;
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
