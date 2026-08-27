export type ReferenceAttributeValue = string | number | boolean | null;

/** Формирует полный PATCH справочника, не теряя поля, скрытые в таблице. */
export function referenceEditPayload(
  name: string,
  attributes: Readonly<Record<string, ReferenceAttributeValue>>
): { readonly name: string; readonly attributes: Readonly<Record<string, ReferenceAttributeValue>> } {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Наименование обязательно");
  return { name: normalizedName, attributes: { ...attributes } };
}
