/**
 * Компетенции инженера: производитель из справочника и линейка приборов.
 * Линейка — начало названия модели целыми частями: «BC» подходит к BC-5000 и BC-6800,
 * «cobas» к cobas c 311, «AU 480» только к AU 480 (не к AU 4800).
 * В базе (engineer_competencies) хранится id производителя и текст линейки; линейка обязательна.
 */
export interface EngineerCompetency {
  readonly id?: string;
  readonly manufacturerId?: string;
  readonly manufacturer?: string;
  readonly modelLine?: string;
}

/** Что уходит на сохранение: производитель по id, имя только для подписи. */
export interface EngineerCompetencyInput {
  readonly manufacturerId: string;
  readonly manufacturer?: string;
  readonly modelLine: string;
}

export const MAX_MODEL_LINE_LENGTH = 100;

const collator = new Intl.Collator("ru-RU", { sensitivity: "base", numeric: true });

/** Линейка без лишних пробелов: так она и сохраняется. */
export function cleanModelLine(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ");
}

function lower(value: string | undefined): string {
  return cleanModelLine(value).toLocaleLowerCase("ru-RU");
}

/**
 * Название частями для сравнения: без регистра, «ё» как «е», буквы и цифры отдельно,
 * пробелы, дефисы и точки не важны. «BC-6800» и «bc 6800» → bc, 6800; «CL-900i» → cl, 900, i.
 */
function nameParts(value: string | undefined): string[] {
  return lower(value).replace(/ё/gu, "е").match(/\p{L}+|\p{N}+/gu) ?? [];
}

/** Одна и та же компетенция: тот же производитель и та же линейка без учёта регистра (как в базе). */
export function competencyKey(item: EngineerCompetency): string {
  const maker = item.manufacturerId ? `id:${item.manufacturerId}` : `name:${lower(item.manufacturer)}`;
  return `${maker}|${lower(item.modelLine)}`;
}

export function competencyLabel(item: EngineerCompetency): string {
  return [item.manufacturer?.trim(), cleanModelLine(item.modelLine)].filter(Boolean).join(" · ");
}

export function sortCompetencies<T extends EngineerCompetency>(items: readonly T[]): T[] {
  return [...items].sort((left, right) =>
    collator.compare(left.manufacturer ?? "", right.manufacturer ?? "")
    || collator.compare(cleanModelLine(left.modelLine), cleanModelLine(right.modelLine)));
}

/** Если у компетенции нет id производителя (пришла только с названием), находим его в справочнике. */
export function withManufacturerIds<T extends EngineerCompetency>(
  items: readonly T[],
  manufacturers: readonly { readonly id: string; readonly name: string }[] = []
): T[] {
  return items.map((item) => {
    if (item.manufacturerId || !item.manufacturer) return item;
    const found = manufacturers.find((maker) => lower(maker.name) === lower(item.manufacturer));
    return found ? { ...item, manufacturerId: found.id } : item;
  });
}

/**
 * Тот же набор компетенций, порядок не важен. Текст линейки сравнивается точно: «bc» вместо «BC»
 * тоже изменение, и его надо сохранить.
 */
export function sameCompetencySet(left: readonly EngineerCompetency[], right: readonly EngineerCompetency[]): boolean {
  const exact = (item: EngineerCompetency) => `${item.manufacturerId ? `id:${item.manufacturerId}` : `name:${lower(item.manufacturer)}`}|${cleanModelLine(item.modelLine)}`;
  const leftKeys = new Set(left.map(exact));
  const rightKeys = new Set(right.map(exact));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

/**
 * Что сохранить по «Сохранить карточку»: теги из окна и линейка, набранная, но не добавленная
 * кнопкой (её не теряем молча). Без производителя такую линейку не сохранить — ошибка.
 * changed: изменился ли набор относительно сохранённого (иначе компетенции не трогаем).
 */
export function competenciesToSave(
  chips: readonly EngineerCompetency[],
  draft: { readonly manufacturerId: string; readonly modelLine: string },
  saved: readonly EngineerCompetency[],
  manufacturers: readonly { readonly id: string; readonly name: string }[]
): { readonly items: readonly EngineerCompetency[]; readonly changed: boolean } | { readonly error: string } {
  let items = withManufacturerIds(chips, manufacturers);
  const pendingLine = cleanModelLine(draft.modelLine);
  if (pendingLine) {
    const maker = manufacturers.find((item) => item.id === draft.manufacturerId);
    if (!maker) return { error: `Выберите производителя для линейки «${pendingLine}» или очистите поле «Линейка»` };
    const pending: EngineerCompetency = { manufacturerId: maker.id, manufacturer: maker.name, modelLine: pendingLine };
    if (!items.some((item) => competencyKey(item) === competencyKey(pending))) items = [...items, pending];
  }
  const sorted = sortCompetencies(items);
  return { items: sorted, changed: !sameCompetencySet(sorted, withManufacturerIds(saved, manufacturers)) };
}

/**
 * Кто выбран в окне назначения. Смена инженера: сразу другой. Назначение задачи, где инженер
 * уже указан (задача ТО с инженером из плана): он, чтобы назначение его подтверждало.
 */
export function preselectedEngineerId(
  ranked: readonly { readonly engineerId: string }[],
  currentEngineerId: string | undefined,
  reassign: boolean
): string {
  if (!reassign && currentEngineerId && ranked.some((item) => item.engineerId === currentEngineerId)) return currentEngineerId;
  return ranked.find((item) => item.engineerId !== currentEngineerId)?.engineerId ?? ranked[0]?.engineerId ?? "";
}

/**
 * Набор для сохранения: у каждой компетенции производитель из справочника и линейка,
 * повторы убраны. Неполная компетенция — ошибка, а не тихий пропуск.
 */
export function competencyPayload(items: readonly EngineerCompetency[]): { readonly manufacturerId: string; readonly modelLine: string }[] {
  const seen = new Set<string>();
  const payload: { manufacturerId: string; modelLine: string }[] = [];
  for (const item of items) {
    const manufacturerId = item.manufacturerId?.trim();
    const modelLine = cleanModelLine(item.modelLine);
    if (!manufacturerId) throw new Error(`Выберите производителя из справочника${item.manufacturer ? ` для «${item.manufacturer}»` : ""}`);
    if (!modelLine) throw new Error("У каждой компетенции нужна линейка приборов");
    if (modelLine.length > MAX_MODEL_LINE_LENGTH) throw new Error(`Линейка длиннее ${MAX_MODEL_LINE_LENGTH} символов`);
    const key = competencyKey({ manufacturerId, modelLine });
    if (seen.has(key)) continue;
    seen.add(key);
    payload.push({ manufacturerId, modelLine });
  }
  return payload;
}

/**
 * Подходит ли компетенция к прибору: тот же производитель, и модель начинается с линейки
 * целыми частями (буквы и цифры по отдельности). Если модель прибора неизвестна, хватает производителя.
 */
export function competencyMatchesEquipment(competency: EngineerCompetency, manufacturer: string, model?: string): boolean {
  const maker = nameParts(manufacturer).join("");
  if (!maker || nameParts(competency.manufacturer).join("") !== maker) return false;
  const line = nameParts(competency.modelLine);
  const deviceModel = nameParts(model);
  if (line.length === 0 || deviceModel.length === 0) return true;
  return line.length <= deviceModel.length && line.every((part, index) => part === deviceModel[index]);
}
