const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * Часовой пояс компании (Санкт-Петербург). Время работ из акта вводим и показываем по нему,
 * а не по поясу устройства: иначе у сотрудника в другом поясе время в акте сдвинется.
 * Москва живёт без перехода на летнее время с 2014 года, смещение постоянное.
 */
export const COMPANY_TIME_ZONE = "Europe/Moscow";
const COMPANY_UTC_OFFSET = "+03:00";

/** Дата выезда и время «чч:мм» по часам компании в момент для базы. */
export function companyDateTimeToIso(date: string, time: string): string {
  const moment = new Date(`${taskCalendarDate(date)}T${time}:00${COMPANY_UTC_OFFSET}`);
  if (Number.isNaN(moment.getTime())) throw new Error("Укажите корректное время");
  return moment.toISOString();
}

function companyParts(value: string | undefined): Readonly<Record<string, string>> | null {
  if (!value) return null;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: COMPANY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(moment);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** «09:30» по часам компании. Пусто, если времени нет. */
export function companyTime(value: string | undefined): string {
  const parts = companyParts(value);
  return parts ? `${parts.hour}:${parts.minute}` : "";
}

/** «13.11.2026» по часам компании. */
export function companyDateText(value: string | undefined): string {
  const parts = companyParts(value);
  return parts ? `${parts.day}.${parts.month}.${parts.year}` : "";
}

/** «13.11.2026 09:30» по часам компании. */
export function companyDateTimeText(value: string | undefined): string {
  const parts = companyParts(value);
  return parts ? `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}` : "";
}

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
