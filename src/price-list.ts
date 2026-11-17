import { formatIsoCalendarDate } from "./date-format.js";
import { russianCountForm } from "./equipment-changes.js";

/**
 * Строка прайса: цена вида работ, действующая с `validFrom` по `validTo`
 * (`null` — действует сейчас). Прошлые строки остаются с заполненным `validTo`:
 * это и есть история цен (таблица `price_list`).
 */
export interface PriceListRow {
  readonly id: string;
  readonly workTypeCode: string;
  /** Категория гарантии или `null` — цена для всех категорий. */
  readonly guaranteeCategoryId: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly amount: number;
  readonly includeGuaranteeWork: boolean;
  readonly createdAt: string;
}

/** Вид работ из справочника: по нему строится список прайса. */
export interface PriceWorkType {
  readonly code: string;
  readonly name: string;
}

/** Категория гарантии из справочника: ей можно задать свою цену. */
export interface PriceGuaranteeCategory {
  readonly id: string;
  readonly name: string;
}

/** Цена без категории гарантии действует для всех: в базе это `scope_key = '*'`. */
export const ALL_CATEGORIES_LABEL = "Для всех категорий";
export const PRICE_NOT_SET_LABEL = "Цена не задана";
/** Что написать в строке, у которой цены ещё нет: что сделать и чем это мешает. */
export const PRICE_NOT_SET_HINT = "Заведите цену: пока её нет, работу не из чего поставить в счёт.";
const UNKNOWN_CATEGORY_LABEL = "Категория не из справочника";

/** Ключ области действия цены, как `scope_key` в базе: категория гарантии или «*». */
export function priceScopeKey(guaranteeCategoryId: string | null | undefined): string {
  // Пустую строку из поля выбора считаем «категория не выбрана», иначе получилась бы своя область действия.
  return guaranteeCategoryId || "*";
}

/** Ключ строки списка: вид работ и область действия цены. */
export function priceLineKey(workTypeCode: string, guaranteeCategoryId: string | null | undefined): string {
  return `${workTypeCode}|${priceScopeKey(guaranteeCategoryId)}`;
}

/** Строка списка прайса: вид работ, область действия, действующая цена и её история. */
export interface PriceLine {
  readonly key: string;
  readonly workTypeCode: string;
  readonly workTypeName: string;
  readonly guaranteeCategoryId: string | null;
  readonly guaranteeCategoryName: string;
  /** Цена, действующая на дату, по которой собран список. */
  readonly current?: PriceListRow;
  /** Ближайшая цена, которая начнёт действовать позже (её ещё можно удалить). */
  readonly next?: PriceListRow;
  /** Вся история строки, новые цены сверху. */
  readonly history: readonly PriceListRow[];
}

function sameScope(row: PriceListRow, workTypeCode: string, guaranteeCategoryId: string | null | undefined): boolean {
  return row.workTypeCode === workTypeCode && priceScopeKey(row.guaranteeCategoryId) === priceScopeKey(guaranteeCategoryId);
}

/** Строка действует на дату: началась не позже и ещё не закончилась (конец не включаем). */
export function priceRowActiveOn(row: PriceListRow, on: string): boolean {
  return row.validFrom <= on && (row.validTo === null || on < row.validTo);
}

/**
 * Цена, действовавшая на дату: сначала по точной категории гарантии, а если такой строки
 * нет — цена «для всех» (`guaranteeCategoryId = null`). Это зеркало функции базы
 * `work_price_on`: по нему берут цену работы для прибора с его категорией гарантии (счёт,
 * акт). В списке прайса подстановки нет намеренно — там у каждой области действия своя строка.
 */
export function effectivePriceRow(
  rows: readonly PriceListRow[],
  query: { readonly workTypeCode: string; readonly guaranteeCategoryId?: string | null; readonly on: string }
): PriceListRow | undefined {
  const exact = rows.find((row) => sameScope(row, query.workTypeCode, query.guaranteeCategoryId) && priceRowActiveOn(row, query.on));
  if (exact || !query.guaranteeCategoryId) return exact;
  return rows.find((row) => sameScope(row, query.workTypeCode, null) && priceRowActiveOn(row, query.on));
}

/** Цена, действовавшая на дату, одним числом: пусто, если цены на эту дату не было. */
export function priceAmountOn(
  rows: readonly PriceListRow[],
  query: { readonly workTypeCode: string; readonly guaranteeCategoryId?: string | null; readonly on: string }
): number | undefined {
  return effectivePriceRow(rows, query)?.amount;
}

/** История одной строки прайса: новые цены сверху, при равной дате начала — поздняя запись выше. */
export function priceRowHistory(
  rows: readonly PriceListRow[],
  query: { readonly workTypeCode: string; readonly guaranteeCategoryId?: string | null }
): readonly PriceListRow[] {
  return rows
    .filter((row) => sameScope(row, query.workTypeCode, query.guaranteeCategoryId))
    .slice()
    .sort((left, right) => right.validFrom.localeCompare(left.validFrom) || right.createdAt.localeCompare(left.createdAt));
}

/**
 * Список прайса: по строке на каждый вид работ (цена «для всех») и ещё по строке на каждую
 * категорию гарантии, которой цену уже задавали. У вида работ без цен строка остаётся:
 * с неё цену и заводят.
 */
export function priceLines(input: {
  readonly workTypes: readonly PriceWorkType[];
  readonly rows: readonly PriceListRow[];
  readonly categories?: readonly PriceGuaranteeCategory[];
  readonly on: string;
}): readonly PriceLine[] {
  const categoryName = (id: string): string => input.categories?.find((item) => item.id === id)?.name ?? UNKNOWN_CATEGORY_LABEL;
  // Виды работ из справочника в его порядке, затем те, что остались только в прайсе
  // (вид работ переименовали или убрали, а цены по нему есть).
  const known = new Set(input.workTypes.map((workType) => workType.code));
  const extra = [...new Set(input.rows.map((row) => row.workTypeCode))].filter((code) => !known.has(code)).sort();
  const workTypes = [...input.workTypes, ...extra.map((code) => ({ code, name: code }))];
  return workTypes.flatMap((workType) => {
    const rows = input.rows.filter((row) => row.workTypeCode === workType.code);
    const scopes: readonly (string | null)[] = [
      null,
      ...[...new Set(rows.map((row) => row.guaranteeCategoryId).filter((id): id is string => Boolean(id)))]
        .sort((left, right) => categoryName(left).localeCompare(categoryName(right), "ru-RU"))
    ];
    return scopes.map((guaranteeCategoryId) => {
      const history = priceRowHistory(rows, { workTypeCode: workType.code, guaranteeCategoryId });
      // Своя цена категории, без подстановки «для всех»: иначе в строке категории
      // показалась бы чужая цена, а правка завела бы ей новую.
      const current = history.find((row) => priceRowActiveOn(row, input.on));
      const next = nextPriceAfter(history, input.on);
      return {
        key: priceLineKey(workType.code, guaranteeCategoryId),
        workTypeCode: workType.code,
        workTypeName: workType.name,
        guaranteeCategoryId,
        guaranteeCategoryName: guaranteeCategoryId ? categoryName(guaranteeCategoryId) : ALL_CATEGORIES_LABEL,
        ...(current ? { current } : {}),
        ...(next ? { next } : {}),
        history
      };
    });
  });
}

/** Поиск по списку: вид работ, его код и категория гарантии. */
export function filterPriceLines(lines: readonly PriceLine[], search: string): readonly PriceLine[] {
  const query = search.trim().toLocaleLowerCase("ru-RU");
  if (!query) return lines;
  return lines.filter((line) => [line.workTypeName, line.workTypeCode, line.guaranteeCategoryName]
    .join(" ").toLocaleLowerCase("ru-RU").includes(query));
}

/**
 * Копейки: 1,005 превращается в 1,01. Умножение на 100 в double даёт 100.49999999999999,
 * поэтому лишний хвост убираем до округления. Пятнадцати значащих цифр хватает и на
 * копейки самой большой суммы, какую примет база (numeric(14,2)).
 */
export function roundToKopecks(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Сумма должна быть числом");
  const scaled = Number((value * 100).toPrecision(15));
  return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / 100;
}

/** Как считаем новую цену выбранным строкам. */
export type BulkPriceMode = "percent" | "delta" | "fixed";

export interface BulkPriceInput {
  readonly mode: BulkPriceMode;
  /** Процент (может быть со знаком минус), прибавка или сама сумма. */
  readonly value: number;
}

/**
 * Новая цена строки: процентом от действующей, прибавкой к ней или одной суммой на все
 * строки. Процентом и прибавкой считать не из чего, пока цены нет, — тогда пусто.
 * Результат ниже нуля к нулю не прижимаем: это ошибка в проценте или прибавке, и строку
 * надо не менять, а объяснить в предпросмотре, почему она пропущена.
 */
export function nextPriceAmount(current: number | undefined, input: BulkPriceInput): number | undefined {
  if (input.mode === "fixed") return roundToKopecks(input.value);
  if (current === undefined) return undefined;
  const raw = input.mode === "percent" ? current * (1 + input.value / 100) : current + input.value;
  return roundToKopecks(raw);
}

/** Что получится у строки после массового изменения. */
export interface BulkPriceChange {
  readonly key: string;
  readonly workTypeCode: string;
  readonly workTypeName: string;
  readonly guaranteeCategoryId: string | null;
  readonly guaranteeCategoryName: string;
  readonly includeGuaranteeWork: boolean;
  /** Действующая цена, если она есть. */
  readonly before?: number;
  /** Новая цена; пусто, если считать не из чего. */
  readonly after?: number;
  /** Почему строка не изменится. */
  readonly skipReason?: string;
}

const NO_BASE_PRICE_REASON = "Цены ещё нет: процентом и прибавкой считать не из чего";
const SAME_PRICE_REASON = "Цена и так такая";
const TOO_LARGE_REASON = "Цена слишком большая";
const ZERO_PRICE_REASON = "Цена стала бы нулём: так нельзя, работа без цены уйдёт клиенту бесплатно";

/** Почему строка с отрицательным результатом не изменится: причина зависит от способа счёта. */
const NEGATIVE_PRICE_REASON: Readonly<Record<BulkPriceMode, string>> = {
  percent: "Цена ушла ниже нуля: снизить больше чем на 100 % нельзя",
  delta: "Цена ушла ниже нуля: проверьте прибавку",
  fixed: "Цена ниже нуля: укажите сумму от нуля"
};

/**
 * Предел столбца `numeric(14, 2)` в базе. Больше неё база отвергает весь вызов целиком,
 * не называя строку, поэтому такие строки отсекаем здесь и показываем это в предпросмотре.
 */
export const MAX_PRICE = 999999999999.99;

/** Что получится у выбранных строк: показываем до применения, вместе с причинами пропуска. */
export function previewBulkPrices(lines: readonly PriceLine[], input: BulkPriceInput): readonly BulkPriceChange[] {
  return lines.map((line) => {
    const before = line.current?.amount;
    const after = nextPriceAmount(before, input);
    const skipReason = after === undefined
      ? NO_BASE_PRICE_REASON
      : after < 0 ? NEGATIVE_PRICE_REASON[input.mode]
        : after === 0 ? ZERO_PRICE_REASON
          : after === before ? SAME_PRICE_REASON : after > MAX_PRICE ? TOO_LARGE_REASON : undefined;
    return {
      key: line.key,
      workTypeCode: line.workTypeCode,
      workTypeName: line.workTypeName,
      guaranteeCategoryId: line.guaranteeCategoryId,
      guaranteeCategoryName: line.guaranteeCategoryName,
      // Флаг гарантии у цены не меняем: массовое изменение касается только суммы.
      includeGuaranteeWork: line.current?.includeGuaranteeWork ?? false,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(skipReason ? { skipReason } : {})
    };
  });
}

/** Позиция для `bulk_update_work_prices`. */
export interface BulkPriceItem {
  readonly workTypeCode: string;
  readonly guaranteeCategoryId: string | null;
  readonly amount: number;
  readonly includeGuaranteeWork: boolean;
}

/**
 * Сколько строк из применяемых станут нулевыми. С 17.11 ноль не применяется вовсе
 * (находка аудита 39): такие строки пропускаются с причиной, и здесь всегда ноль.
 */
export function zeroPriceCount(changes: readonly BulkPriceChange[]): number {
  return changes.filter((change) => !change.skipReason && change.after === 0).length;
}

/**
 * Предупреждение о нулевых ценах: согласовано целиком, а не только числом.
 * «Станет бесплатной 1 строка: в счёт такая работа не попадёт.»
 */
export function zeroPriceWarning(count: number): string {
  if (count === 0) return "";
  return russianCountForm(count, [
    `Станет бесплатной ${count} строка: в счёт такая работа не попадёт.`,
    `Станут бесплатными ${count} строки: в счёт такие работы не попадут.`,
    `Станут бесплатными ${count} строк: в счёт такие работы не попадут.`
  ]);
}

/** Строки, которые уйдут в базу: без пропущенных и без тех, где цена не меняется. */
export function bulkPriceItems(changes: readonly BulkPriceChange[]): readonly BulkPriceItem[] {
  return changes
    .filter((change): change is BulkPriceChange & { readonly after: number } => change.after !== undefined && !change.skipReason)
    .map((change) => ({
      workTypeCode: change.workTypeCode,
      guaranteeCategoryId: change.guaranteeCategoryId,
      amount: change.after,
      includeGuaranteeWork: change.includeGuaranteeWork
    }));
}

const NON_BREAKING_SPACE = " ";

/** «1 234,56 ₽»: разряды и копейки, как в счетах, независимо от локали устройства. */
export function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const kopecks = Math.round(Math.abs(roundToKopecks(amount)) * 100);
  const rubles = String(Math.floor(kopecks / 100)).replace(/\B(?=(\d{3})+$)/gu, NON_BREAKING_SPACE);
  const fraction = String(kopecks % 100).padStart(2, "0");
  return `${amount < 0 ? "−" : ""}${rubles},${fraction}${NON_BREAKING_SPACE}₽`;
}

/** Сумма из поля ввода: «1 234,56» и «1234.56» одинаково. Пусто, не число или минус — null. */
export function parseAmount(value: string): number | null {
  const normalized = value.replace(/[\s ]/gu, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  // Число из трёхсот с лишним знаков превращается в Infinity, а округление копеек на нём
  // бросает исключение. Поле читается прямо при отрисовке окна, так что это был бы белый экран.
  if (!Number.isFinite(parsed)) return null;
  return roundToKopecks(parsed);
}

/** Процент или прибавка из поля ввода: со знаком, «-10» и «−10» одинаково. */
export function parseSignedNumber(value: string): number | null {
  const normalized = value.replace(/[\s ]/gu, "").replace("−", "-").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Цена строки для списка или «Цена не задана». */
export function priceLineAmountText(line: Pick<PriceLine, "current">): string {
  return line.current ? formatMoney(line.current.amount) : PRICE_NOT_SET_LABEL;
}

/** Дата начала действующей цены или прочерк, пока цены нет. */
export function priceLineStartText(line: Pick<PriceLine, "current">): string {
  return line.current ? formatIsoCalendarDate(line.current.validFrom) : "—";
}

/** Пометка про гарантию: включается ли работа по гарантии в счёт. */
export function guaranteeWorkLabel(includeGuaranteeWork: boolean): string {
  return includeGuaranteeWork ? "Гарантия в счёт" : "Без гарантии";
}

/** День накануне: в базе конец периода цены не входит в период (valid_to — день начала следующей). */
function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Срок действия цены для истории: «с 01.01.2026», «01.01.2026 — 30.06.2026».
 * Пишем последний день действия, а не день начала следующей цены: иначе 1 июля
 * стояло бы в двух периодах сразу, и непонятно, какая цена у работы этого дня.
 */
export function priceRowPeriodText(row: Pick<PriceListRow, "validFrom" | "validTo">): string {
  const from = formatIsoCalendarDate(row.validFrom);
  if (!row.validTo) return `с ${from}`;
  const last = dayBefore(row.validTo);
  return last <= row.validFrom ? from : `${from} — ${formatIsoCalendarDate(last)}`;
}

/** Цена задним числом: дата начала раньше сегодняшнего дня. Её подтверждают отдельно. */
export function isBackdatedPrice(validFrom: string, today: string): boolean {
  return Boolean(validFrom) && validFrom < today;
}

/** Нулевая цена не бывает: бесплатную работу отмечают гарантией в задаче, а не ценой. */
export const ZERO_PRICE_MESSAGE = "Цена должна быть больше нуля: работу, за которую клиент не платит, отмечают гарантией в задаче, а не нулевой ценой";

/** Будущая цена, о которой стоит предупредить в строке: «с 01.01.2027 — 1 200,00 ₽». */
export function priceLineNextText(line: Pick<PriceLine, "next">): string | undefined {
  return line.next ? `с ${formatIsoCalendarDate(line.next.validFrom)} — ${formatMoney(line.next.amount)}` : undefined;
}

/**
 * Ближайшая цена, которая начинается позже даты. Если такая есть, новая цена с этой даты
 * будет закрыта её началом (так делает `set_work_price`) и действующей не станет.
 */
export function nextPriceAfter(history: readonly PriceListRow[], validFrom: string): PriceListRow | undefined {
  // История идёт от новых к старым, поэтому ближайшая из поздних цен — последняя из них.
  return [...history].sort((left, right) => right.validFrom.localeCompare(left.validFrom))
    .filter((row) => row.validFrom > validFrom).at(-1);
}

/** Удалить можно только ещё не начавшуюся цену: историю база не отдаёт (`delete_future_work_price`). */
export function canDeletePriceRow(row: Pick<PriceListRow, "validFrom">, today: string): boolean {
  return row.validFrom > today;
}
