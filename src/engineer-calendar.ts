/**
 * Календарь загрузки инженеров: границы периода, раскладка задач по дням и подсчёт загрузки.
 *
 * Модуль чистый: ни запросов, ни React, ни текущего времени внутри функций — «сегодня»
 * всегда приходит снаружи как день компании (Москва, см. companyToday в task-dates.ts).
 * Та же раскладка нужна и странице календаря, и подсказке при назначении инженера,
 * и тестам, поэтому логика лежит здесь, а не в компонентах.
 *
 * Решения, принятые здесь (одинаковые в календаре и в подсказке):
 * 1. День задачи — это период «с … по …» (deadline_from … deadline_to) целиком: задача
 *    на три дня занимает инженера все три дня, а не только первый. Если периода нет,
 *    но есть дата выезда, задача занимает один этот день.
 * 2. Задача без периода и без даты выезда ни на какой день не раскладывается: она попадает
 *    в отдельный список «Без срока» у инженера. Иначе её пришлось бы молча ставить на
 *    сегодня и календарь показывал бы занятость, которой нет. У новых задач период
 *    обязателен (ограничение tasks_execution_period_required, миграция 0001), поэтому
 *    такие задачи бывают только из старых данных — и терять их в календаре нельзя.
 * 3. «Перегружен» — три и более задачи в один день (OVERLOADED_TASKS_PER_DAY): столько
 *    выездов в день по городу уже не успеть. Один-два дня — норма, ноль — окно.
 * 4. Нерабочий день — суббота и воскресенье: графика работ и отпусков в системе нет,
 *    поэтому другой источник «не работает» взять негде. Неактивный инженер не работает
 *    совсем, его строка в календаре помечена и в подсказке он не предлагается.
 */

import { formatRussianCount } from "./equipment-changes.js";

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MS_IN_DAY = 86_400_000;

/** Три задачи в один день — уже перегруз: столько выездов за день не успеть. */
export const OVERLOADED_TASKS_PER_DAY = 3;

/**
 * Больше 62 дней (два самых длинных месяца) своим периодом не показываем: строка инженера
 * перестаёт читаться, а выборка начинает тянуть лишние задачи со стенда.
 */
export const MAX_CALENDAR_DAYS = 62;

export type CalendarMode = "week" | "month" | "custom";

export interface CalendarRange {
  readonly from: string;
  readonly to: string;
}

export const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"] as const;
const MONTH_IN_CASE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;
const MONTH_NOMINATIVE = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** Календарная дата «2026-11-16» в число дней от эпохи; у некорректной даты — ошибка по-русски. */
function dayNumber(value: string, field = "дата"): number {
  const match = CALENDAR_DATE.exec(value.trim());
  if (!match) throw new Error(`Укажите ${field} в виде ГГГГ-ММ-ДД`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const moment = Date.UTC(year, month - 1, day);
  const parsed = new Date(moment);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Укажите существующую ${field}`);
  }
  return moment / MS_IN_DAY;
}

/** Обратно: число дней от эпохи в «2026-11-16». */
function dayDate(value: number): string {
  return new Date(value * MS_IN_DAY).toISOString().slice(0, 10);
}

/** Сдвиг календарной даты на несколько дней: «2026-11-16» + 3 = «2026-11-19». */
export function shiftCalendarDay(date: string, days: number): string {
  return dayDate(dayNumber(date) + days);
}

/** День недели: понедельник = 1, воскресенье = 7 (как в ISO, а не как в Date.getUTCDay). */
export function calendarWeekday(date: string): number {
  return ((dayNumber(date) + 3) % 7 + 7) % 7 + 1;
}

/** Суббота и воскресенье: другого источника нерабочих дней в системе нет. */
export function isWeekend(date: string): boolean {
  return calendarWeekday(date) >= 6;
}

/** Сколько дней в периоде включительно. */
export function calendarDayCount(range: CalendarRange): number {
  return dayNumber(range.to, "дату окончания") - dayNumber(range.from, "дату начала") + 1;
}

/** Период недели (Пн—Вс), в которую попадает день. */
export function weekRange(date: string): CalendarRange {
  const start = dayNumber(date) - (calendarWeekday(date) - 1);
  return { from: dayDate(start), to: dayDate(start + 6) };
}

/** Период месяца, в который попадает день. */
export function monthRange(date: string): CalendarRange {
  const match = CALENDAR_DATE.exec(date.trim());
  if (!match) throw new Error("Укажите дату в виде ГГГГ-ММ-ДД");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const from = dayNumber(`${match[1]}-${match[2]}-01`);
  const nextMonth = month === 12 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, month, 1);
  return { from: dayDate(from), to: dayDate(nextMonth / MS_IN_DAY - 1) };
}

/**
 * Границы периода календаря. Неделя и месяц считаются от выбранного дня, свой период берётся
 * как есть: даты по возрастанию и не длиннее MAX_CALENDAR_DAYS, иначе отказ по-русски —
 * пустой календарь с молча обрезанным периодом хуже понятной ошибки.
 */
export function calendarRange(mode: CalendarMode, anchor: string, custom?: Partial<CalendarRange>): CalendarRange {
  if (mode === "week") return weekRange(anchor);
  if (mode === "month") return monthRange(anchor);
  const from = (custom?.from ?? "").trim();
  const to = (custom?.to ?? "").trim();
  if (!from || !to) throw new Error("Укажите начало и конец периода");
  const fromDay = dayNumber(from, "дату начала");
  const toDay = dayNumber(to, "дату окончания");
  if (toDay < fromDay) throw new Error("Конец периода не может быть раньше начала");
  if (toDay - fromDay + 1 > MAX_CALENDAR_DAYS) {
    throw new Error(`Период календаря не длиннее ${MAX_CALENDAR_DAYS} дней: выберите период короче`);
  }
  return { from: dayDate(fromDay), to: dayDate(toDay) };
}

/** Соседний период той же длины: «‹» и «›» над календарём. «Своим периодом» двигаемся на его длину. */
export function shiftCalendarRange(range: CalendarRange, mode: CalendarMode, direction: -1 | 1): CalendarRange {
  if (mode === "week") return weekRange(shiftCalendarDay(range.from, 7 * direction));
  if (mode === "month") {
    const anchor = monthRange(range.from);
    return monthRange(direction < 0 ? shiftCalendarDay(anchor.from, -1) : shiftCalendarDay(anchor.to, 1));
  }
  const length = calendarDayCount(range);
  return { from: shiftCalendarDay(range.from, length * direction), to: shiftCalendarDay(range.to, length * direction) };
}

/** Период словами для заголовка: «16—22 ноября 2026», «ноябрь 2026», «28 октября — 3 ноября 2026». */
export function calendarRangeTitle(range: CalendarRange, mode: CalendarMode): string {
  const from = CALENDAR_DATE.exec(range.from.trim());
  const to = CALENDAR_DATE.exec(range.to.trim());
  if (!from || !to) throw new Error("Укажите период в виде ГГГГ-ММ-ДД");
  const monthStart = monthRange(range.from);
  if (mode === "month" || (range.from === monthStart.from && range.to === monthStart.to)) {
    return `${MONTH_NOMINATIVE[Number(from[2]) - 1]} ${from[1]}`;
  }
  const fromDay = Number(from[3]);
  const toDay = Number(to[3]);
  const fromMonth = MONTH_IN_CASE[Number(from[2]) - 1];
  const toMonth = MONTH_IN_CASE[Number(to[2]) - 1];
  if (range.from === range.to) return `${fromDay} ${fromMonth} ${from[1]}`;
  if (from[1] === to[1] && from[2] === to[2]) return `${fromDay}—${toDay} ${toMonth} ${to[1]}`;
  if (from[1] === to[1]) return `${fromDay} ${fromMonth} — ${toDay} ${toMonth} ${to[1]}`;
  return `${fromDay} ${fromMonth} ${from[1]} — ${toDay} ${toMonth} ${to[1]}`;
}

export interface CalendarDay {
  readonly date: string;
  /** Пн = 1 … Вс = 7. */
  readonly weekday: number;
  readonly weekdayLabel: string;
  /** Число месяца без ведущего нуля: «16». */
  readonly dayLabel: string;
  /** «ноя»: подписываем первый день календаря и каждое первое число. */
  readonly monthLabel: string;
  readonly isWeekend: boolean;
  readonly isToday: boolean;
  readonly isPast: boolean;
  /** Первый день периода или первое число месяца: по нему рисуем разделитель месяцев. */
  readonly startsMonth: boolean;
}

/** Дни периода по порядку: шапка календаря и колонки строк инженеров. */
export function calendarDays(range: CalendarRange, today: string): readonly CalendarDay[] {
  const from = dayNumber(range.from, "дату начала");
  const to = dayNumber(range.to, "дату окончания");
  if (to < from) throw new Error("Конец периода не может быть раньше начала");
  const days: CalendarDay[] = [];
  for (let day = from; day <= to; day += 1) {
    const date = dayDate(day);
    const weekday = calendarWeekday(date);
    const month = Number(date.slice(5, 7));
    days.push({
      date,
      weekday,
      weekdayLabel: WEEKDAY_LABELS[weekday - 1] ?? "",
      dayLabel: String(Number(date.slice(8, 10))),
      monthLabel: MONTH_SHORT[month - 1] ?? "",
      isWeekend: weekday >= 6,
      isToday: date === today,
      isPast: date < today,
      startsMonth: day === from || date.slice(8, 10) === "01"
    });
  }
  return days;
}

/** Задача в календаре: только то, что нужно раскладке и карточке дня. */
export interface CalendarTask {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly status: string;
  readonly engineerId?: string;
  readonly priority?: "urgent" | "planned";
  /** Период «с … по …» задачи (deadline_from / deadline_to). */
  readonly periodFrom?: string;
  readonly periodTo?: string;
  readonly visitDate?: string;
  readonly siteName?: string;
  readonly equipmentLabel?: string;
  readonly isOverdue?: boolean;
}

export interface CalendarEngineer {
  readonly id: string;
  readonly fullName: string;
  readonly isActive: boolean;
}

/** Дни, которые задача занимает у инженера: период целиком, иначе день выезда, иначе ничего. */
export function taskOccupiedRange(task: Pick<CalendarTask, "periodFrom" | "periodTo" | "visitDate">): CalendarRange | undefined {
  const from = task.periodFrom?.slice(0, 10);
  const to = task.periodTo?.slice(0, 10);
  if (from && to) return to < from ? { from: to, to: from } : { from, to };
  const single = from ?? to ?? task.visitDate?.slice(0, 10);
  return single ? { from: single, to: single } : undefined;
}

export type DayLoadLevel = "free" | "normal" | "overloaded";

/** Уровень дня по числу задач: окно, норма или перегруз. */
export function dayLoadLevel(taskCount: number): DayLoadLevel {
  if (taskCount === 0) return "free";
  return taskCount >= OVERLOADED_TASKS_PER_DAY ? "overloaded" : "normal";
}

export interface CalendarPlacement {
  readonly task: CalendarTask;
  /** Этот день — первый день задачи внутри календаря (здесь пишем номер и название). */
  readonly isFirstVisibleDay: boolean;
  readonly isLastVisibleDay: boolean;
  /** Период задачи начался раньше или кончается позже показанного: рисуем стрелку. */
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
  /** Какой это день периода задачи и сколько их всего: «день 2 из 3». */
  readonly dayIndex: number;
  readonly dayCount: number;
  /** На этот день назначен выезд (visit_date). */
  readonly isVisitDay: boolean;
}

export interface CalendarCell {
  readonly date: string
  readonly isWeekend: boolean;
  readonly isToday: boolean;
  readonly level: DayLoadLevel;
  readonly placements: readonly CalendarPlacement[];
}

export interface CalendarRowSummary {
  /** Уникальных задач, попавших в период (задача на три дня считается один раз). */
  readonly taskCount: number;
  /** Самый занятый день периода: сколько в нём задач. */
  readonly busiestDayCount: number;
  /** Дней с задачами и свободных рабочих дней (выходные в свободные не попадают). */
  readonly busyDayCount: number;
  readonly freeWorkdayCount: number;
  readonly overloadedDayCount: number;
  readonly overdueTaskCount: number;
}

export interface CalendarRow {
  readonly engineer: CalendarEngineer;
  readonly cells: readonly CalendarCell[];
  readonly summary: CalendarRowSummary;
  /** Задачи инженера без периода и без даты выезда: на дни не раскладываются. */
  readonly undatedTasks: readonly CalendarTask[];
}

export interface EngineerCalendar {
  readonly range: CalendarRange;
  readonly days: readonly CalendarDay[];
  readonly rows: readonly CalendarRow[];
  /** Задачи периода без инженера: координатору видно, что их ещё некому отдать. */
  readonly unassignedTasks: readonly CalendarTask[];
  readonly totals: {
    readonly taskCount: number;
    readonly overloadedEngineerCount: number;
    readonly freeEngineerCount: number;
    readonly undatedTaskCount: number;
  };
}

function compareTasksInDay(left: CalendarTask, right: CalendarTask): number {
  // Сначала просрочки, потом срочные, потом по номеру: в дне с тремя задачами важное сверху.
  if (Boolean(left.isOverdue) !== Boolean(right.isOverdue)) return left.isOverdue ? -1 : 1;
  if ((left.priority === "urgent") !== (right.priority === "urgent")) return left.priority === "urgent" ? -1 : 1;
  return left.number.localeCompare(right.number, "ru");
}

/**
 * Раскладка календаря: строка на инженера, колонка на день периода.
 * Задачи приходят уже отобранными по периоду (функция базы engineer_calendar_tasks),
 * здесь только раскладка и подсчёты.
 */
export function buildEngineerCalendar(input: {
  readonly engineers: readonly CalendarEngineer[];
  readonly tasks: readonly CalendarTask[];
  readonly range: CalendarRange;
  readonly today: string;
}): EngineerCalendar {
  const days = calendarDays(input.range, input.today);
  const rangeFrom = dayNumber(input.range.from, "дату начала");
  const rangeTo = dayNumber(input.range.to, "дату окончания");
  const byEngineer = new Map<string, CalendarTask[]>();
  const unassigned: CalendarTask[] = [];
  for (const task of input.tasks) {
    if (!task.engineerId) {
      unassigned.push(task);
      continue;
    }
    const list = byEngineer.get(task.engineerId);
    if (list) list.push(task);
    else byEngineer.set(task.engineerId, [task]);
  }

  const rows = input.engineers.map((engineer): CalendarRow => {
    const tasks = byEngineer.get(engineer.id) ?? [];
    const perDay = new Map<string, CalendarPlacement[]>();
    const undated: CalendarTask[] = [];
    const visibleTaskIds = new Set<string>();
    let overdueTaskCount = 0;
    for (const task of tasks) {
      const occupied = taskOccupiedRange(task);
      if (!occupied) {
        undated.push(task);
        continue;
      }
      const taskFrom = dayNumber(occupied.from, "начало периода задачи");
      const taskTo = dayNumber(occupied.to, "конец периода задачи");
      const visibleFrom = Math.max(taskFrom, rangeFrom);
      const visibleTo = Math.min(taskTo, rangeTo);
      if (visibleTo < visibleFrom) continue;
      visibleTaskIds.add(task.id);
      if (task.isOverdue) overdueTaskCount += 1;
      const dayCount = taskTo - taskFrom + 1;
      const visitDay = task.visitDate?.slice(0, 10);
      for (let day = visibleFrom; day <= visibleTo; day += 1) {
        const date = dayDate(day);
        const placement: CalendarPlacement = {
          task,
          isFirstVisibleDay: day === visibleFrom,
          isLastVisibleDay: day === visibleTo,
          continuesBefore: taskFrom < rangeFrom,
          continuesAfter: taskTo > rangeTo,
          dayIndex: day - taskFrom + 1,
          dayCount,
          isVisitDay: visitDay === date
        };
        const list = perDay.get(date);
        if (list) list.push(placement);
        else perDay.set(date, [placement]);
      }
    }
    const cells = days.map((day): CalendarCell => {
      const placements = [...(perDay.get(day.date) ?? [])].sort((left, right) => compareTasksInDay(left.task, right.task));
      return {
        date: day.date,
        isWeekend: day.isWeekend,
        isToday: day.isToday,
        level: dayLoadLevel(placements.length),
        placements
      };
    });
    const busiestDayCount = cells.reduce((max, cell) => Math.max(max, cell.placements.length), 0);
    return {
      engineer,
      cells,
      summary: {
        taskCount: visibleTaskIds.size,
        busiestDayCount,
        busyDayCount: cells.filter((cell) => cell.placements.length > 0).length,
        freeWorkdayCount: cells.filter((cell) => !cell.isWeekend && cell.placements.length === 0).length,
        overloadedDayCount: cells.filter((cell) => cell.level === "overloaded").length,
        overdueTaskCount
      },
      undatedTasks: [...undated].sort(compareTasksInDay)
    };
  });

  return {
    range: input.range,
    days,
    rows,
    unassignedTasks: [...unassigned].sort(compareTasksInDay),
    totals: {
      taskCount: new Set(rows.flatMap((row) => row.cells.flatMap((cell) => cell.placements.map((item) => item.task.id)))).size,
      overloadedEngineerCount: rows.filter((row) => row.summary.overloadedDayCount > 0).length,
      freeEngineerCount: rows.filter((row) => row.engineer.isActive && row.summary.taskCount === 0).length,
      undatedTaskCount: rows.reduce((sum, row) => sum + row.undatedTasks.length, 0)
    }
  };
}

/** Занятость инженера на период задачи: что показывает подсказка при назначении. */
export interface EngineerPeriodLoad {
  readonly engineerId: string;
  /** Задач в периоде назначаемой задачи. */
  readonly taskCount: number;
  /** Самый занятый день периода. */
  readonly busiestDayCount: number;
  readonly busiestDay?: string;
  /** Рабочих дней периода без задач. */
  readonly freeWorkdayCount: number;
  /** Рабочих дней в периоде всего (без выходных). */
  readonly workdayCount: number;
  /** Свободен все рабочие дни периода. */
  readonly isFree: boolean;
  /** Хотя бы в один день периода три задачи и больше. */
  readonly isOverloaded: boolean;
  /** В периоде нет ни одного рабочего дня: все дни выходные. */
  readonly worksNoDay: boolean;
  readonly overdueTaskCount: number;
}

/**
 * Занятость каждого инженера на период назначаемой задачи. Период берётся у самой задачи:
 * если его нет, подсказка считает занятость на день выезда, а без него — на «сегодня»,
 * иначе сравнивать инженеров было бы нечем.
 */
export function engineerPeriodLoad(input: {
  readonly engineers: readonly CalendarEngineer[];
  readonly tasks: readonly CalendarTask[];
  readonly range: CalendarRange;
  readonly today: string;
  /** Назначаемую задачу в её собственную занятость не считаем. */
  readonly ignoreTaskId?: string;
}): readonly EngineerPeriodLoad[] {
  const calendar = buildEngineerCalendar({
    engineers: input.engineers,
    tasks: input.ignoreTaskId ? input.tasks.filter((task) => task.id !== input.ignoreTaskId) : input.tasks,
    range: input.range,
    today: input.today
  });
  return calendar.rows.map((row) => {
    const busiest = row.cells.reduce<CalendarCell | undefined>(
      (best, cell) => (!best || cell.placements.length > best.placements.length ? cell : best),
      undefined
    );
    const workdayCount = row.cells.filter((cell) => !cell.isWeekend).length;
    return {
      engineerId: row.engineer.id,
      taskCount: row.summary.taskCount,
      busiestDayCount: row.summary.busiestDayCount,
      ...(busiest && busiest.placements.length > 0 ? { busiestDay: busiest.date } : {}),
      freeWorkdayCount: row.summary.freeWorkdayCount,
      workdayCount,
      isFree: row.summary.taskCount === 0,
      isOverloaded: row.summary.overloadedDayCount > 0,
      worksNoDay: workdayCount === 0,
      overdueTaskCount: row.summary.overdueTaskCount
    };
  });
}

/**
 * Занятость из чисел базы (функция engineer_period_load, миграция 0051). База считает
 * только количества, а «свободен», «перегружен» и «не работает» решаются здесь, по тем же
 * правилам, что и при расчёте из задач: порог перегруза живёт в одном месте.
 */
export function periodLoadFromCounts(input: {
  readonly engineerId: string;
  readonly taskCount: number;
  readonly busiestDayCount: number;
  readonly busiestDay?: string;
  readonly freeWorkdayCount: number;
  readonly workdayCount: number;
  readonly overdueTaskCount: number;
}): EngineerPeriodLoad {
  return {
    engineerId: input.engineerId,
    taskCount: input.taskCount,
    busiestDayCount: input.busiestDayCount,
    ...(input.busiestDay && input.busiestDayCount > 0 ? { busiestDay: input.busiestDay } : {}),
    freeWorkdayCount: input.freeWorkdayCount,
    workdayCount: input.workdayCount,
    isFree: input.taskCount === 0,
    isOverloaded: input.busiestDayCount >= OVERLOADED_TASKS_PER_DAY,
    worksNoDay: input.workdayCount === 0,
    overdueTaskCount: input.overdueTaskCount
  };
}

/** «16 ноября»: день в подсказке пишем словами, без года — период всегда рядом. */
export function calendarDayTitle(date: string): string {
  const match = CALENDAR_DATE.exec(date.trim());
  if (!match) return "";
  return `${Number(match[3])} ${MONTH_IN_CASE[Number(match[2]) - 1] ?? ""}`.trim();
}

/**
 * Занятость одной строкой для списка инженеров при назначении. Решение принимает человек,
 * поэтому пишем факт, а не запрет: «Свободен все 5 дней», «3 задачи 17 ноября — перегружен».
 */
export function periodLoadText(load: EngineerPeriodLoad): string {
  if (load.worksNoDay) return "В эти дни не работает: только выходные";
  if (load.isFree) return `Свободен все ${formatRussianCount(load.workdayCount, ["день", "дня", "дней"])} периода`;
  const busiest = load.busiestDay ? ` ${calendarDayTitle(load.busiestDay)}` : "";
  const peak = `${formatRussianCount(load.busiestDayCount, ["задача", "задачи", "задач"])}${busiest}`;
  const free = load.freeWorkdayCount > 0 ? `, свободных дней ${load.freeWorkdayCount}` : ", свободных дней нет";
  const overdue = load.overdueTaskCount > 0 ? `, просрочек ${load.overdueTaskCount}` : "";
  return `${load.isOverloaded ? `Перегружен: ${peak}` : `Занят: ${peak}`}${free}${overdue}`;
}

/** Подсказка при назначении: компетенции плюс занятость на период задачи. */
export interface AssignmentCandidate {
  readonly engineerId: string;
  readonly fullName: string;
  readonly isAvailable: boolean;
  readonly previouslyWorkedWithEquipment: boolean;
  readonly load?: EngineerPeriodLoad;
}

/**
 * Порядок подсказки: сначала кто работал с таким прибором, потом свободные, потом не
 * перегруженные, внутри — по самому занятому дню и по имени. Запрета нет: перегруженный
 * инженер остаётся в списке, просто ниже.
 */
export function rankAssignmentCandidates<T extends AssignmentCandidate>(candidates: readonly T[]): readonly T[] {
  return [...candidates].sort((left, right) => {
    if (left.previouslyWorkedWithEquipment !== right.previouslyWorkedWithEquipment) {
      return left.previouslyWorkedWithEquipment ? -1 : 1;
    }
    const leftWorks = left.load?.worksNoDay !== true;
    const rightWorks = right.load?.worksNoDay !== true;
    if (leftWorks !== rightWorks) return leftWorks ? -1 : 1;
    const leftOverloaded = left.load?.isOverloaded === true;
    const rightOverloaded = right.load?.isOverloaded === true;
    if (leftOverloaded !== rightOverloaded) return leftOverloaded ? 1 : -1;
    const leftPeak = left.load?.busiestDayCount ?? (left.isAvailable ? 0 : 1);
    const rightPeak = right.load?.busiestDayCount ?? (right.isAvailable ? 0 : 1);
    if (leftPeak !== rightPeak) return leftPeak - rightPeak;
    const leftTasks = left.load?.taskCount ?? 0;
    const rightTasks = right.load?.taskCount ?? 0;
    if (leftTasks !== rightTasks) return leftTasks - rightTasks;
    if (left.isAvailable !== right.isAvailable) return left.isAvailable ? -1 : 1;
    return left.fullName.localeCompare(right.fullName, "ru");
  });
}

/**
 * На какой период считать занятость для подсказки: период задачи, иначе день выезда,
 * иначе сегодняшний день компании.
 */
export function assignmentLoadRange(
  task: Pick<CalendarTask, "periodFrom" | "periodTo" | "visitDate">,
  today: string
): CalendarRange {
  return taskOccupiedRange(task) ?? { from: today, to: today };
}
