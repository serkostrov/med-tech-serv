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

// Форматтеры создаём один раз: отчёт и выгрузка зовут их на каждую задачу, а новый Intl.DateTimeFormat дорогой.
const COMPANY_PARTS_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: COMPANY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const COMPANY_CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: COMPANY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

function companyParts(value: string | undefined): Readonly<Record<string, string>> | null {
  if (!value) return null;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return null;
  return Object.fromEntries(COMPANY_PARTS_FORMAT.formatToParts(moment).map((part) => [part.type, part.value]));
}

/** Календарная дата или пусто, если такой даты нет («2026-02-30» не превращается в 2 марта). */
function calendarDateOrUndefined(value: string): string | undefined {
  try {
    return taskCalendarDate(value);
  } catch {
    return undefined;
  }
}

/** Начало дня «2026-11-01» по часам компании как момент ISO (граница периода отчёта). Пусто, если даты нет. */
export function companyDayStart(date: string): string | undefined {
  const day = calendarDateOrUndefined(date);
  return day ? new Date(`${day}T00:00:00${COMPANY_UTC_OFFSET}`).toISOString() : undefined;
}

/** Последний миг дня по часам компании (23:59:59.999) как момент ISO. Пусто, если даты нет. */
export function companyDayEnd(date: string): string | undefined {
  const day = calendarDateOrUndefined(date);
  return day ? new Date(`${day}T23:59:59.999${COMPANY_UTC_OFFSET}`).toISOString() : undefined;
}

/** Сегодня по часам компании («2026-11-13»): от него считаем просрочку на доске, в фильтрах и отчётах. */
export function companyToday(now = new Date()): string {
  return companyDay(now.toISOString()) ?? now.toISOString().slice(0, 10);
}

/** «2026-11-13»: календарный день момента по часам компании (для отчётов «вовремя» и по месяцам). */
export function companyDay(value: string | undefined): string | undefined {
  const parts = companyParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : undefined;
}

/** Год, месяц, день, часы, минуты, секунды момента по часам компании (для дат в Excel). */
export function companyClock(value: string): readonly number[] | undefined {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return undefined;
  const parts = Object.fromEntries(COMPANY_CLOCK_FORMAT.formatToParts(moment).map((part) => [part.type, part.value]));
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number);
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

/**
 * Дата вызова и даты событий прибора не бывают из будущего: заявка не могла поступить,
 * а событие произойти позже сегодняшнего дня. Правило держит база (миграция 0037),
 * здесь то же самое, чтобы отказ пришёл в форме. Сегодняшний день разрешён целиком.
 */
export function isFutureCompanyDate(date: string, now = new Date()): boolean {
  const day = calendarDateOrUndefined(date);
  return day !== undefined && day > companyToday(now);
}

/** То же для момента «дата и время»: сравниваем день по часам компании. */
export function isFutureCompanyMoment(value: string, now = new Date()): boolean {
  const day = companyDay(value);
  return day !== undefined && day > companyToday(now);
}

/** Отказ словами: подставляем название поля, чтобы человек понял, какое исправлять. */
export function assertNotFutureCompanyMoment(value: string, label: string, now = new Date()): void {
  if (isFutureCompanyMoment(value, now)) {
    throw new Error(`${label} не может быть из будущего: событие не могло произойти позже сегодняшнего дня`);
  }
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

/**
 * Что не так со сроком задачи — одно правило для создания и для «Изменить»
 * (аудит 17.11, № 77, 78). Начало «с» может быть раньше даты вызова: задача из плана ТО
 * заводится уже внутри своего периода. А конец «по» раньше вызова — опечатка: работа
 * не могла закончиться раньше, чем поступила заявка. Пусто — срок в порядке.
 */
export function taskPeriodProblem(input: { readonly periodFrom: string; readonly periodTo: string; readonly callDate?: string }): string {
  if (!input.periodFrom || !input.periodTo) return "Укажите период выполнения: даты «с» и «по»";
  if (input.periodFrom > input.periodTo) return "Начало периода не может быть позже конца";
  if (input.callDate && input.periodTo < input.callDate) {
    return `Срок «по» ${companyDateTextFromIso(input.periodTo)} раньше даты вызова ${companyDateTextFromIso(input.callDate)}: работа не могла закончиться раньше, чем поступила заявка`;
  }
  return "";
}

function companyDateTextFromIso(date: string): string {
  const [year, month, day] = date.slice(0, 10).split("-");
  return year && month && day ? `${day}.${month}.${year}` : date;
}

