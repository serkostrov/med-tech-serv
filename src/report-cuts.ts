/**
 * Раскладка разрезов отчёта на экране: сколько строк показываем и от чего считаем доли.
 * Отдельным файлом, чтобы страница и её проверки не тянули друг друга: расчёт чистый,
 * React ему не нужен.
 */
import type { ReportCutItem } from "./m2-api.js";

/**
 * Разрезы по приборам, площадкам и инженерам могут быть длинными: на экране показываем
 * первые строки, остальные целиком уходят в выгрузку. В файле обрезки нет.
 */
export const CUT_ROWS_ON_SCREEN = 8;

/** Строка разреза для полос: ключ списка, подпись, значение и (необязательно) код для цвета. */
export interface CutRow {
  readonly code?: string;
  readonly key: string;
  readonly name: string;
  readonly value: number;
}

/**
 * Первые строки разреза для экрана. Цвет полосы берётся из кода, поэтому код
 * оставляем только там, где он из справочника («wear», «G»): у приборов, площадок
 * и инженеров это идентификаторы записей, и класс по ним смысла не имеет.
 */
export function cutRows(items: readonly ReportCutItem[], colored: boolean): readonly CutRow[] {
  return items.slice(0, CUT_ROWS_ON_SCREEN).map((item) => ({
    ...(colored ? { code: item.code } : {}),
    key: item.code,
    name: item.name,
    value: item.value
  }));
}

/**
 * От чего считать доли в полосах. Когда на экране часть строк разреза, доли должны
 * остаться теми же, что в выгрузке, то есть от всего разреза, — иначе видимые строки
 * всегда складывались бы в сто процентов. Переданный итог меньше показанного не бывает:
 * если он почему-то меньше, берём показанное, чтобы доли не ушли за сто процентов.
 */
export function reportBarsTotal(items: readonly { readonly value: number }[], whole?: number): number {
  const shown = items.reduce((sum, item) => sum + item.value, 0);
  return Math.max(shown, whole ?? 0);
}
