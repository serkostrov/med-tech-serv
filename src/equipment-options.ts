import type { EquipmentApiRecord } from "./m2-api.js";

/** Сколько приборов показываем в выпадающем списке за раз: остальное находится поиском. */
export const EQUIPMENT_OPTIONS_LIMIT = 100;

const collator = new Intl.Collator("ru-RU", { sensitivity: "base", numeric: true });

function normalize(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
}

/** Без пробелов, дефисов и слешей: «TC-7A 001284» находится по «tc7a001». */
function compact(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function equipmentOptionTitle(item: EquipmentApiRecord): string {
  return [item.manufacturer, item.model].map((part) => part?.trim()).filter(Boolean).join(" ") || "Прибор";
}

/** Вторая строка в списке: заводской номер, площадка и плательщик. */
export function equipmentOptionMeta(item: EquipmentApiRecord): string {
  return [`S/N ${item.serialNumber}`, item.site?.trim() || "площадка не указана", item.payer?.trim()].filter(Boolean).join(" · ");
}

/**
 * Приборы для выпадающего списка: по площадке, затем по модели и номеру, с фильтром по любому слову
 * из модели, номера, площадки, организации или плательщика.
 */
export function filterEquipmentOptions(
  items: readonly EquipmentApiRecord[],
  query: string,
  limit = EQUIPMENT_OPTIONS_LIMIT
): { readonly items: readonly EquipmentApiRecord[]; readonly total: number } {
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  const matching = tokens.length === 0 ? [...items] : items.filter((item) => {
    const haystack = normalize([item.manufacturer, item.model, item.serialNumber, item.site, item.organization, item.payer, item.statusName].filter(Boolean).join(" "));
    const packed = compact(haystack);
    return tokens.every((token) => haystack.includes(token) || (compact(token).length > 0 && packed.includes(compact(token))));
  });
  matching.sort((left, right) =>
    collator.compare(left.site ?? "", right.site ?? "")
    || collator.compare(equipmentOptionTitle(left), equipmentOptionTitle(right))
    || collator.compare(left.serialNumber, right.serialNumber));
  return { items: matching.slice(0, limit), total: matching.length };
}
