import { formatIsoCalendarDate, isoCalendarDate, parseIsoCalendarDate } from "./date-format.js";

/**
 * Переход из отчёта в список задач (встреча с заказчиком 16.11: «Просрочено 2 —
 * можно ли нажать и посмотреть, что это за задачи?»).
 *
 * Отчёт отбирает заявки по дню создания, а фильтр «Период» в задачах — по сроку
 * выполнения. Если передать в список период как есть, цифра в отчёте и число строк
 * в списке разойдутся. Поэтому переход несёт свой отбор по дню создания, и список
 * показывает ровно те заявки, что посчитаны в отчёте.
 */
export interface TaskDrillDown {
  /** Что показали: «Просроченные», «Вид работ: Диагностика» — пишется над списком. */
  readonly title: string;
  /** Период отчёта по дню создания заявки, ISO-даты включительно. */
  readonly createdFrom: string;
  readonly createdTo: string;
  readonly status?: string;
  readonly overdue?: boolean;
  readonly openOnly?: boolean;
  readonly workTypeCode?: string;
  /** «G» гарантийный случай, «N» вина клиента, «none» без отметки. */
  readonly guarantee?: "G" | "N" | "none";
  /** Причина обращения; «none» — причина не указана. */
  readonly reasonCode?: string;
  readonly equipmentId?: string;
  readonly siteId?: string;
  /** «none» — инженер не назначен. */
  readonly engineerId?: string;
  /** Из плана ТО (true) или разовая заявка (false). */
  readonly maintenancePlan?: boolean;
}

export type ReportMetricKind = "all" | "closed" | "overdue" | "open";

export type ReportCutKind = "status" | "work_type" | "month" | "source" | "reason" | "modifier" | "equipment" | "site" | "engineer";

const METRIC_TITLES: Readonly<Record<ReportMetricKind, string>> = {
  all: "Все заявки",
  closed: "Закрытые",
  overdue: "Просроченные",
  open: "Открытые"
};

const CUT_TITLES: Readonly<Record<ReportCutKind, string>> = {
  status: "Этап",
  work_type: "Вид работ",
  month: "Месяц",
  source: "Откуда задача",
  reason: "Причина обращения",
  modifier: "Гарантия",
  equipment: "Прибор",
  site: "Площадка",
  engineer: "Инженер"
};

/** «01.11.2026 — 16.11.2026»: период под заголовком списка. */
export function drillPeriodText(drill: Pick<TaskDrillDown, "createdFrom" | "createdTo">): string {
  return `созданы ${formatIsoCalendarDate(drill.createdFrom)} — ${formatIsoCalendarDate(drill.createdTo)}`;
}

/** Цифра из шапки отчёта: «Просрочено», «Закрыто» и так далее. */
export function metricDrillDown(kind: ReportMetricKind, period: { readonly from: string; readonly to: string }): TaskDrillDown {
  const base = { title: METRIC_TITLES[kind], createdFrom: period.from, createdTo: period.to };
  if (kind === "closed") return { ...base, status: "closed" };
  if (kind === "overdue") return { ...base, overdue: true };
  if (kind === "open") return { ...base, openOnly: true };
  return base;
}

/** Последний день месяца «2026-11» — для разреза «по месяцам». */
function monthBounds(key: string): { readonly from: string; readonly to: string } | null {
  const parsed = parseIsoCalendarDate(`${key}-01`);
  if (!parsed) return null;
  const from = isoCalendarDate(parsed.year, parsed.month, 1);
  const nextMonth = new Date(Date.UTC(parsed.year, parsed.month, 1));
  const last = new Date(nextMonth.getTime() - 86_400_000);
  const to = isoCalendarDate(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate());
  return from && to ? { from, to } : null;
}

/**
 * Полоса разреза. Код «unset» база отдаёт для «не указано»: у причины и инженера
 * такие задачи можно найти, у прибора и площадки — нет (без них задачу не создать),
 * для них перехода нет. Разрез запчастей по Г/Н/Б в задачи не ведёт: это позиции, а не заявки.
 */
export function cutDrillDown(
  kind: ReportCutKind,
  item: { readonly code: string; readonly name: string },
  period: { readonly from: string; readonly to: string }
): TaskDrillDown | null {
  const title = `${CUT_TITLES[kind]}: ${item.name}`;
  const base = { title, createdFrom: period.from, createdTo: period.to };
  const unset = item.code === "unset" || item.code === "";
  switch (kind) {
    case "status": return unset ? null : { ...base, status: item.code };
    case "work_type": return unset ? null : { ...base, workTypeCode: item.code };
    case "month": {
      const bounds = monthBounds(item.code);
      if (!bounds) return null;
      // Месяц обрезаем периодом отчёта: в ноябре отчёта по 16-е — ноябрь по 16-е.
      const from = bounds.from > period.from ? bounds.from : period.from;
      const to = bounds.to < period.to ? bounds.to : period.to;
      return { ...base, title: `${CUT_TITLES.month}: ${item.name}`, createdFrom: from, createdTo: to };
    }
    case "source": return unset ? null : { ...base, maintenancePlan: item.code === "plan" };
    case "reason": return { ...base, reasonCode: unset ? "none" : item.code };
    case "modifier": return { ...base, guarantee: unset ? "none" : item.code === "G" ? "G" : item.code === "N" ? "N" : "none" };
    case "equipment": return unset ? null : { ...base, equipmentId: item.code };
    case "site": return unset ? null : { ...base, siteId: item.code };
    case "engineer": return { ...base, engineerId: unset ? "none" : item.code };
  }
}
