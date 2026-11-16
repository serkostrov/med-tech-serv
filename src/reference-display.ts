import type { ReferenceCatalogDescriptor, ReferenceCatalogValue } from "./m2-api.js";

type Field = ReferenceCatalogDescriptor["fields"][number];

/** Названия связанных справочников: ключ справочника → его записи. */
export type RelatedCatalogValues = Readonly<Record<string, readonly ReferenceCatalogValue[]>>;

/**
 * Название записи связанного справочника по её идентификатору.
 * В колонке «Параметры» нельзя показывать `manufacturerId`: на демо это короткий
 * код вроде `m-bc`, а на стенде — длинный служебный идентификатор записи.
 */
export function referenceValueName(
  catalogKey: string,
  id: string,
  related: RelatedCatalogValues
): string | undefined {
  const values = related[catalogKey];
  if (!values) return undefined;
  const found = values.find((value) => value.id === id || value.code === id);
  return found?.name;
}

/**
 * Эта ли запись выбрана в поле. Сравниваем и по идентификатору, и по коду — так же,
 * как название ищется для списка: иначе скрытый производитель, записанный кодом,
 * пропал бы из выпадающего списка и обязательное поле молча слетело бы в «Не выбрано».
 */
export function isSelectedReference(value: ReferenceCatalogValue, selected: unknown): boolean {
  const key = selected === null || selected === undefined ? "" : String(selected);
  return key !== "" && (value.id === key || value.code === key);
}

/** Значение параметра так, как его читает человек. */
export function referenceAttributeText(
  field: Field | undefined,
  value: string | number | boolean | null,
  related: RelatedCatalogValues
): string {
  if (value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (field?.type === "reference" && field.referenceCatalog) {
    const name = referenceValueName(field.referenceCatalog, String(value), related);
    if (name !== undefined) return name;
    // Справочник загружен, а записи в нём нет: привязка битая, и молчать об этом нельзя.
    // Пока справочник не загрузился — лучше ничего, чем служебный код.
    return related[field.referenceCatalog] ? "запись не найдена" : "—";
  }
  return String(value);
}

/**
 * Колонка «Параметры» строки справочника: «Производитель: Beckman Coulter · Категория: …».
 * Порядок берём из описания справочника, чтобы он не зависел от порядка ключей в ответе.
 */
export function referenceAttributesSummary(
  fields: readonly Field[],
  attributes: Readonly<Record<string, string | number | boolean | null>>,
  related: RelatedCatalogValues
): string {
  const shown = fields.filter((field) => field.key !== "sortOrder" && field.key in attributes);
  const extra = Object.keys(attributes).filter((key) => key !== "sortOrder" && !fields.some((field) => field.key === key));
  const parts = [
    ...shown.map((field) => `${field.label}: ${referenceAttributeText(field, attributes[field.key] ?? null, related)}`),
    ...extra.map((key) => `${key}: ${referenceAttributeText(undefined, attributes[key] ?? null, related)}`)
  ].filter((part) => !part.endsWith(": —"));
  return parts.join(" · ") || "—";
}
