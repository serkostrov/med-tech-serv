import type { OperationsReportRecord, ReportTaskRow } from "./m2-api.js";
import { reportTaskOverdue } from "./m2-api.js";
import { buildXlsxCompressed, type XlsxCell, type XlsxSheet } from "./xlsx.js";

/** «2026-11-12» → «12.11.2026». */
function dayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

/** Закрыта вовремя: дата закрытия не позже конца срока. Без срока или не закрыта: пусто. */
function closedOnTime(task: ReportTaskRow): string {
  if (task.status !== "closed" || !task.periodTo || !task.completedAt) return "";
  const completed = new Date(task.completedAt);
  const day = Number.isNaN(completed.getTime())
    ? task.completedAt.slice(0, 10)
    : `${completed.getFullYear()}-${String(completed.getMonth() + 1).padStart(2, "0")}-${String(completed.getDate()).padStart(2, "0")}`;
  return day <= task.periodTo.slice(0, 10) ? "Да" : "Нет";
}

/**
 * Отчёт по заявкам для Excel: лист «Сводка» (те же цифры, что на странице) и лист «Заявки»
 * со всеми заявками периода, по одной строке, с фильтрами в шапке.
 */
export function reportWorkbookSheets(report: OperationsReportRecord, tasks: readonly ReportTaskRow[], today?: string): readonly XlsxSheet[] {
  const period = `${dayLabel(report.period.from)} – ${dayLabel(report.period.to)}`;
  const cancelled = report.tasksByStatus.find((item) => item.code === "cancelled")?.value ?? 0;
  const open = Math.max(0, report.metrics.taskCount - report.metrics.closedCount - cancelled);
  const total = Math.max(1, report.metrics.taskCount);
  const share = (value: number): XlsxCell => ({ percent: value / total });
  const summary: XlsxCell[][] = [
    [{ bold: "Отчёт по заявкам МедТехСервис" }],
    ["Период", period],
    [],
    [{ bold: "Показатель" }, { bold: "Значение" }],
    ["Всего заявок", report.metrics.taskCount],
    ["Закрыто", report.metrics.closedCount],
    ["Закрыто вовремя", report.metrics.closedCount ? { percent: report.metrics.closedOnTimePercent / 100 } : ""],
    ["Просрочено", report.metrics.overdueCount],
    ["Открытые", open],
    [],
    [{ bold: "По этапам" }, { bold: "Заявок" }, { bold: "Доля" }],
    ...report.tasksByStatus.map((item) => [item.name, item.value, share(item.value)]),
    [],
    [{ bold: "По видам работ" }, { bold: "Заявок" }, { bold: "Доля" }],
    ...report.tasksByWorkType.map((item) => [item.name, item.value, share(item.value)]),
    [],
    [{ bold: "По месяцам" }, { bold: "Заявок" }, { bold: "Доля" }],
    ...report.tasksByMonth.map((item) => [item.name, item.value, share(item.value)])
  ];
  const header = ["Номер", "Создана", "Название", "Этап", "Срочность", "Вид работ", "Площадка", "Прибор", "Заводской номер", "Инженер", "Срок с", "Срок по", "Закрыта", "Закрыта вовремя", "Просрочена"];
  const taskRows: XlsxCell[][] = tasks.map((task) => [
    task.number,
    { date: task.createdAt, withTime: true },
    task.title,
    task.statusName,
    task.priority === "urgent" ? "Срочная" : "Плановая",
    task.workTypeName ?? "",
    task.siteName ?? "",
    task.equipment ?? "",
    task.serialNumber ?? "",
    task.engineerName ?? "",
    task.periodFrom ? { date: task.periodFrom.slice(0, 10) } : "",
    task.periodTo ? { date: task.periodTo.slice(0, 10) } : "",
    task.completedAt ? { date: task.completedAt, withTime: true } : "",
    closedOnTime(task),
    reportTaskOverdue(task.periodTo, task.status, report.period.to, today) ? "Да" : ""
  ]);
  return [
    { name: "Сводка", rows: summary, widths: [34, 26, 10] },
    {
      name: "Заявки",
      rows: [header, ...taskRows],
      headerRow: 1,
      widths: [12, 17, 40, 14, 11, 22, 30, 28, 18, 26, 11, 11, 17, 16, 12]
    }
  ];
}

export function reportFileName(report: OperationsReportRecord): string {
  return `Отчёт по заявкам ${dayLabel(report.period.from)}–${dayLabel(report.period.to)}.xlsx`;
}

export function reportWorkbook(report: OperationsReportRecord, tasks: readonly ReportTaskRow[]): Promise<Uint8Array> {
  return buildXlsxCompressed(reportWorkbookSheets(report, tasks));
}
