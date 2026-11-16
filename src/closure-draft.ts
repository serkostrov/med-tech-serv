/**
 * Черновик результата работ.
 *
 * Инженер заполняет результат на выезде, часто с телефона и плохой связи. Если
 * страница перезагрузится, браузер закроется или сохранение не дойдёт до сервера,
 * набранное пропадает целиком, а это самая длинная форма в системе. Поэтому всё,
 * что он печатает, складывается в браузер и возвращается при следующем открытии.
 *
 * Черновик живёт только у этого человека в этом браузере и до сервера не доходит:
 * это подстраховка, а не хранение. Поэтому любое обращение к хранилищу обёрнуто —
 * в приватном окне и при запрете на данные сайта оно бросает исключение, и форма
 * должна открыться как обычно, просто без черновика.
 */

const PREFIX = "medtech-closure-draft:";
/** Старые черновики не всплывают через месяцы: задача давно закрыта, а текст сбивает с толку. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Поля результата работ, которые есть смысл помнить. Файлы сюда не кладём: их браузер так не хранит. */
export const CLOSURE_DRAFT_FIELDS = [
  "callReason",
  "workDescription",
  "recommendations",
  "userRemarks",
  "reasonCode",
  "workModifier",
  "visitDate",
  "workStartTime",
  "workFinishTime",
  "meterReading",
  "hours",
  "workCompleted",
  "apparatusApproved",
  "customerHasNoClaims",
  "continuedInPrimary"
] as const;

export type ClosureDraftField = (typeof CLOSURE_DRAFT_FIELDS)[number];
export type ClosureDraftValues = Partial<Record<ClosureDraftField, string>>;

export interface ClosureDraft {
  readonly values: ClosureDraftValues;
  /** Когда черновик записан, ISO. Показываем человеку, чтобы он понимал, что восстановилось. */
  readonly savedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Значения формы, которые стоит помнить. Пустые не храним: они и так пустые. */
export function closureDraftValues(form: FormData): ClosureDraftValues {
  const values: Record<string, string> = {};
  for (const field of CLOSURE_DRAFT_FIELDS) {
    const raw = form.get(field);
    const value = typeof raw === "string" ? raw : raw === null ? "" : "";
    if (value) values[field] = value;
  }
  return values;
}

/** Пустой черновик не храним: он ничего не спасает, а подпись «восстановлен» путает. */
export function closureDraftIsEmpty(values: ClosureDraftValues): boolean {
  return Object.values(values).every((value) => !value);
}

export function saveClosureDraft(taskId: string, values: ClosureDraftValues, now = new Date()): void {
  const store = storage();
  if (!store || !taskId) return;
  try {
    if (closureDraftIsEmpty(values)) {
      store.removeItem(PREFIX + taskId);
      return;
    }
    store.setItem(PREFIX + taskId, JSON.stringify({ values, savedAt: now.toISOString() }));
  } catch {
    // Приватное окно или запрет на данные сайта: форма работает и без черновика.
  }
}

export function readClosureDraft(taskId: string, now = new Date()): ClosureDraft | null {
  const store = storage();
  if (!store || !taskId) return null;
  try {
    const raw = store.getItem(PREFIX + taskId);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const savedAt = (parsed as { savedAt?: unknown }).savedAt;
    const values = (parsed as { values?: unknown }).values;
    if (typeof savedAt !== "string" || !values || typeof values !== "object") return null;
    const saved = Date.parse(savedAt);
    if (!Number.isFinite(saved) || now.getTime() - saved > MAX_AGE_MS) {
      store.removeItem(PREFIX + taskId);
      return null;
    }
    const clean: Record<string, string> = {};
    for (const field of CLOSURE_DRAFT_FIELDS) {
      const value = (values as Record<string, unknown>)[field];
      if (typeof value === "string" && value) clean[field] = value;
    }
    if (closureDraftIsEmpty(clean)) return null;
    return { values: clean, savedAt };
  } catch {
    return null;
  }
}

export function clearClosureDraft(taskId: string): void {
  const store = storage();
  if (!store || !taskId) return;
  try {
    store.removeItem(PREFIX + taskId);
  } catch {
    // Нечего чистить: хранилище недоступно.
  }
}

/** Значение поля: из черновика, если он есть, иначе то, что уже сохранено в задаче. */
export function closureDraftValue(draft: ClosureDraft | null, field: ClosureDraftField, saved: string): string {
  const value = draft?.values[field];
  return value === undefined ? saved : value;
}

/** Галочка акта: в черновике она лежит как «on», как её отдаёт форма. */
export function closureDraftChecked(draft: ClosureDraft | null, field: ClosureDraftField, saved: boolean): boolean {
  const value = draft?.values[field];
  return value === undefined ? saved : value === "on";
}
