const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Периоды задачи являются календарными датами и не должны зависеть от UTC-зоны браузера. */
export function taskCalendarDate(value: string): string {
  const normalized = value.trim();
  const match = CALENDAR_DATE.exec(normalized);
  if (!match) throw new Error("Укажите корректную календарную дату");
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.getUTCFullYear() !== Number(year)
    || parsed.getUTCMonth() !== Number(month) - 1
    || parsed.getUTCDate() !== Number(day)) {
    throw new Error("Укажите существующую календарную дату");
  }
  return normalized;
}
