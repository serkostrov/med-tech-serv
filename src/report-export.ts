import type { OperationsReportRecord, ReportCutItem, ReportTaskRow } from "./m2-api.js";
import { closedOnTime, reportTaskOverdue } from "./m2-api.js";
import { companyToday } from "./task-dates.js";
import { buildXlsxCompressed, type XlsxCell, type XlsxSheet } from "./xlsx.js";

/** «2026-11-12» → «12.11.2026». */
function dayLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

/** Закрыта вовремя: то же правило, что в сводке. Не закрыта или без срока: пусто. */
function closedOnTimeLabel(task: ReportTaskRow): string {
  if (task.status !== "closed") return "";
  const onTime = closedOnTime(task.completedAt, task.periodTo);
  return onTime === undefined ? "" : onTime ? "Да" : "Нет";
}

/** Блок разреза: шапка и строки «значение, заявок, доля, закрыто, просрочено». */
function cutBlock(
  title: string,
  items: readonly ReportCutItem[],
  share: (value: number) => XlsxCell
): readonly XlsxCell[][] {
  if (items.length === 0) return [];
  return [
    [],
    [{ bold: title }, { bold: "Заявок" }, { bold: "Доля" }, { bold: "Закрыто" }, { bold: "Просрочено" }],
    ...items.map((item): XlsxCell[] => [item.name, item.value, share(item.value), item.closed, item.overdue])
  ];
}

/**
 * Лист «Разрезы»: причины обращений, гарантийность работ и замен запчастей, приборы,
 * площадки и инженеры. Разрезы из блока 10 ТЗ, которых нет на листе «Сводка».
 * Пусто (листа не будет), пока в базе нет миграции с разрезами.
 */
function reportCutsSheet(report: OperationsReportRecord, share: (value: number) => XlsxCell): XlsxSheet | undefined {
  const partsTotal = Math.max(1, report.partsByCondition.reduce((sum, item) => sum + item.positionCount, 0));
  const rows: XlsxCell[][] = [
    [{ bold: "Разрезы отчёта" }],
    ["Период", `${dayLabel(report.period.from)} – ${dayLabel(report.period.to)}`],
    ...cutBlock("Причины обращений", report.tasksByReason, share),
    ...cutBlock("Гарантийность работ", report.worksByModifier, share),
    ...(report.partsByCondition.length
      ? [
          [],
          [{ bold: "Гарантийность замен запчастей" }, { bold: "Позиций" }, { bold: "Доля" }, { bold: "Заявок" }, { bold: "Количество" }] as XlsxCell[],
          ...report.partsByCondition.map((item): XlsxCell[] => [
            item.name, item.positionCount, { percent: item.positionCount / partsTotal }, item.taskCount, item.quantity
          ])
        ]
      : []),
    ...cutBlock("Приборы", report.tasksByEquipment, share),
    ...cutBlock("Площадки", report.tasksBySite, share),
    ...cutBlock("Инженеры", report.tasksByEngineer, share)
  ];
  // Шапка и период — ещё не разрезы: без них лист не нужен.
  return rows.length > 2 ? { name: "Разрезы", rows, widths: [46, 10, 10, 10, 12] } : undefined;
}

/** Лист «Загрузка инженеров»: занятые дни периода и заявки по каждому инженеру. */
function reportEngineerLoadSheet(report: OperationsReportRecord): XlsxSheet | undefined {
  if (report.engineerLoad.length === 0) return undefined;
  const header = ["Инженер", "Заявок со сроком в периоде", "Закрыто", "Просрочено", "Занятых дней", "Дней в периоде", "Загрузка", "Часы"];
  return {
    name: "Загрузка инженеров",
    headerRow: 1,
    widths: [30, 26, 10, 12, 14, 16, 11, 9],
    rows: [
      header,
      ...report.engineerLoad.map((item): XlsxCell[] => [
        item.name,
        item.taskCount,
        item.closedCount,
        item.overdueCount,
        item.busyDays,
        item.periodDays,
        item.periodDays ? { percent: item.busyDays / item.periodDays } : "",
        item.workHours || ""
      ])
    ]
  };
}

/**
 * Лист «Затраты»: деньги по приборам и по плательщикам. Лист появляется только у того,
 * кому деньги видны (право `finance.read`): у инженера и кладовщика его в файле нет.
 */
function reportSpendSheet(report: OperationsReportRecord): XlsxSheet | undefined {
  if (!report.canSeeFinance) return undefined;
  if (report.equipmentSpend.length === 0 && report.payerSpend.length === 0) return undefined;
  const rows: XlsxCell[][] = [
    [{ bold: "Затраты за период" }],
    ["Период", `${dayLabel(report.period.from)} – ${dayLabel(report.period.to)}`],
    ["Считаем по", "неотменённым счетам; дата счёта — день выставления, у черновика — день создания"],
    ...(report.equipmentSpend.length
      ? [
          [],
          ["По приборам", "позиции счетов, привязанные к задачам прибора"],
          [{ bold: "Прибор" }, { bold: "Площадка и плательщик" }, { bold: "Заявок" }, { bold: "Счетов" }, { bold: "Работы" }, { bold: "Запчасти" }, { bold: "Итого" }] as XlsxCell[],
          ...report.equipmentSpend.map((item): XlsxCell[] => [
            item.name, item.detail ?? "", item.taskCount, item.invoiceCount, item.workAmount, item.partsAmount, item.totalAmount
          ])
        ]
      : []),
    ...(report.payerSpend.length
      ? [
          [],
          ["По плательщикам", "итоги счетов целиком, вместе с корректировкой: сумма больше, чем по приборам"],
          [{ bold: "Плательщики" }, { bold: "Корректировка" }, { bold: "Заявок" }, { bold: "Счетов" }, { bold: "Работы" }, { bold: "Запчасти" }, { bold: "Итого" }] as XlsxCell[],
          ...report.payerSpend.map((item): XlsxCell[] => [
            item.name,
            // Корректировка стоит рядом с плательщиком: она объясняет разницу между
            // суммой работ с запчастями и итогом счёта.
            item.adjustmentAmount || "",
            item.taskCount, item.invoiceCount, item.workAmount, item.partsAmount, item.totalAmount
          ])
        ]
      : [])
  ];
  return { name: "Затраты", rows, widths: [40, 34, 10, 10, 14, 14, 14] };
}

/**
 * Отчёт по заявкам для Excel: лист «Сводка» (те же цифры, что на странице), листы
 * разрезов, загрузки инженеров и затрат, и лист «Заявки» со всеми заявками периода,
 * по одной строке, с фильтрами в шапке.
 */
export function reportWorkbookSheets(report: OperationsReportRecord, tasks: readonly ReportTaskRow[], today?: string): readonly XlsxSheet[] {
  // «Сегодня» по Москве один раз на всю выгрузку, а не на каждую строку.
  const day = today ?? companyToday();
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
  const cuts = reportCutsSheet(report, share);
  const load = reportEngineerLoadSheet(report);
  const spend = reportSpendSheet(report);
  const header = ["Номер", "Создана", "Название", "Этап", "Срочность", "Вид работ", "Площадка", "Прибор", "Заводской номер", "Инженер", "Срок с", "Срок по", "Окончание работ", "Закрыта вовремя", "Просрочена"];
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
    // Время окончания только если его ввели в результате работ: иначе дата окончания это полдень
    // дня выезда или момент сдачи, и время в отчёте было бы придуманным.
    task.completedAt ? { date: task.completedAt, withTime: Boolean(task.workFinishedAt) } : "",
    closedOnTimeLabel(task),
    reportTaskOverdue(task.periodTo, task.status, report.period.to, day) ? "Да" : ""
  ]);
  return [
    { name: "Сводка", rows: summary, widths: [34, 26, 10] },
    ...(cuts ? [cuts] : []),
    ...(load ? [load] : []),
    ...(spend ? [spend] : []),
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
