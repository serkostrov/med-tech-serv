const CALENDAR_ISO = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DISPLAY_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/u;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isoCalendarDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function todayIsoDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseIsoCalendarDate(value: string): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = CALENDAR_ISO.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isoCalendarDate(year, month, day) ? { year, month, day } : null;
}

export function parseDisplayDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const iso = parseIsoCalendarDate(trimmed);
  if (iso) return isoCalendarDate(iso.year, iso.month, iso.day);
  const match = DISPLAY_DATE.exec(trimmed);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += year >= 70 ? 1900 : 2000;
  return isoCalendarDate(year, month, day);
}

export function formatIsoCalendarDate(value: string | undefined | null): string {
  if (!value) return "";
  const parsed = parseIsoCalendarDate(value.slice(0, 10));
  if (!parsed) return "";
  return `${pad(parsed.day)}.${pad(parsed.month)}.${parsed.year}`;
}

function formatLocalParts(date: Date, withTime: boolean): string {
  const stamp = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  if (!withTime) return stamp;
  return `${stamp}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Календарные YYYY-MM-DD без сдвига зоны; остальное — локальное время. */
export function formatDisplayDate(value: string | Date | undefined | null, withTime = false): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") {
    const calendar = parseIsoCalendarDate(value.trim());
    if (calendar) return `${pad(calendar.day)}.${pad(calendar.month)}.${calendar.year}`;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return formatLocalParts(parsed, withTime);
  }
  if (Number.isNaN(value.getTime())) return "";
  return formatLocalParts(value, withTime);
}

export function formatDisplayDateTime(value: string | Date | undefined | null): string {
  return formatDisplayDate(value, true);
}

export function formatDisplayTime(value: string | Date | undefined | null): string {
  if (value === undefined || value === null || value === "") return "";
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(parsed.getTime())) return typeof value === "string" ? value : "";
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function splitLocalDateTime(value: string | undefined | null): { readonly date: string; readonly time: string } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec((value ?? "").trim());
  if (match?.[1] && match[2]) return { date: match[1], time: match[2] };
  return { date: "", time: "" };
}

export function joinLocalDateTime(date: string, time: string): string {
  if (!date) return "";
  return `${date}T${time || "00:00"}`;
}

/**
 * Время «чч:мм». С телефона двоеточие не набрать на цифровой клавиатуре, поэтому принимаем
 * и 9.30, 9,30, 9 30, 930, 0930, а просто 9 значит 09:00.
 */
export function parseDisplayTime(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const match = /^(\d{1,2})[:.,\s](\d{2})$/u.exec(trimmed)
    ?? /^(\d{1,2})(\d{2})$/u.exec(trimmed)
    ?? (/^\d{1,2}$/u.test(trimmed) ? [trimmed, trimmed, "00"] as const : null);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}
