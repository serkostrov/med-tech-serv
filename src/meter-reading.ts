/**
 * Показание счётчика прибора.
 *
 * Счётчик наработки только растёт: по нему считают ресурс узлов и планируют ТО.
 * Запрет держит база (миграция 0038), здесь то же правило, чтобы инженер увидел отказ
 * в форме результата, а не после отправки.
 */

/** Показание в привычном виде: 152 300, а не 152300. */
export function formatMeterReading(value: number): string {
  return value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

/** Отказ словами или пусто, если показание можно сохранить. */
export function meterReadingRefusal(value: number | undefined, previous: number | undefined): string | null {
  if (value === undefined || Number.isNaN(value)) return null;
  if (value < 0) return "Показание счётчика не может быть отрицательным";
  if (previous !== undefined && value < previous) {
    return `Показание счётчика ${formatMeterReading(value)} меньше предыдущего (${formatMeterReading(previous)}): счётчик прибора только растёт. Проверьте значение на приборе`;
  }
  return null;
}
