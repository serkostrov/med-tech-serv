import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_CALENDAR_DAYS,
  OVERLOADED_TASKS_PER_DAY,
  assignmentLoadRange,
  buildEngineerCalendar,
  calendarDayCount,
  calendarDayTitle,
  calendarDays,
  calendarRange,
  calendarRangeTitle,
  calendarWeekday,
  dayLoadLevel,
  engineerPeriodLoad,
  isWeekend,
  monthRange,
  periodLoadText,
  rankAssignmentCandidates,
  shiftCalendarDay,
  shiftCalendarRange,
  taskOccupiedRange,
  weekRange,
  type CalendarEngineer,
  type CalendarTask
} from "./engineer-calendar.js";

const engineers: readonly CalendarEngineer[] = [
  { id: "e-1", fullName: "Антонов Антон", isActive: true },
  { id: "e-2", fullName: "Борисов Борис", isActive: true },
  { id: "e-3", fullName: "Вавилов Виктор", isActive: false }
];

function task(input: Partial<CalendarTask> & { readonly id: string }): CalendarTask {
  return {
    number: `З-${input.id}`,
    title: "Ремонт",
    status: "assigned",
    ...input
  };
}

describe("границы периода календаря", () => {
  it("неделя считается с понедельника по воскресенье, в какой бы день её ни открыли", () => {
    // 16.11.2026 — понедельник, 22.11.2026 — воскресенье.
    assert.deepEqual(weekRange("2026-11-16"), { from: "2026-11-16", to: "2026-11-22" });
    assert.deepEqual(weekRange("2026-11-22"), { from: "2026-11-16", to: "2026-11-22" });
    assert.deepEqual(weekRange("2026-11-19"), { from: "2026-11-16", to: "2026-11-22" });
    assert.equal(calendarWeekday("2026-11-16"), 1);
    assert.equal(calendarWeekday("2026-11-22"), 7);
    assert.equal(isWeekend("2026-11-21"), true);
    assert.equal(isWeekend("2026-11-20"), false);
  });

  it("неделя на стыке месяцев и года не рвётся", () => {
    assert.deepEqual(weekRange("2026-12-31"), { from: "2026-12-28", to: "2027-01-03" });
    assert.deepEqual(weekRange("2027-01-01"), { from: "2026-12-28", to: "2027-01-03" });
  });

  it("месяц берётся целиком, включая февраль високосного года", () => {
    assert.deepEqual(monthRange("2026-11-16"), { from: "2026-11-01", to: "2026-11-30" });
    assert.deepEqual(monthRange("2026-12-05"), { from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(monthRange("2028-02-10"), { from: "2028-02-01", to: "2028-02-29" });
    assert.deepEqual(monthRange("2027-02-10"), { from: "2027-02-01", to: "2027-02-28" });
    assert.equal(calendarDayCount(monthRange("2026-11-16")), 30);
  });

  it("свой период берётся как есть, но с проверками по-русски", () => {
    assert.deepEqual(calendarRange("custom", "2026-11-16", { from: "2026-11-10", to: "2026-11-12" }), { from: "2026-11-10", to: "2026-11-12" });
    assert.throws(() => calendarRange("custom", "2026-11-16", { from: "2026-11-12", to: "2026-11-10" }), /раньше начала/u);
    assert.throws(() => calendarRange("custom", "2026-11-16", { from: "", to: "2026-11-10" }), /начало и конец/u);
    assert.throws(() => calendarRange("custom", "2026-11-16", { from: "2026-02-30", to: "2026-03-02" }), /существующую/u);
    assert.throws(() => calendarRange("custom", "2026-11-16", { from: "2026-01-01", to: "2026-12-31" }), new RegExp(`${MAX_CALENDAR_DAYS} дней`, "u"));
    // Ровно предел пропускаем.
    const limit = calendarRange("custom", "2026-11-16", { from: "2026-07-01", to: shiftCalendarDay("2026-07-01", MAX_CALENDAR_DAYS - 1) });
    assert.equal(calendarDayCount(limit), MAX_CALENDAR_DAYS);
  });

  it("соседний период той же длины: неделя, месяц и свой период", () => {
    assert.deepEqual(shiftCalendarRange(weekRange("2026-11-16"), "week", 1), { from: "2026-11-23", to: "2026-11-29" });
    assert.deepEqual(shiftCalendarRange(weekRange("2026-11-16"), "week", -1), { from: "2026-11-09", to: "2026-11-15" });
    assert.deepEqual(shiftCalendarRange(monthRange("2026-11-16"), "month", 1), { from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(shiftCalendarRange(monthRange("2027-01-10"), "month", -1), { from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(shiftCalendarRange({ from: "2026-11-10", to: "2026-11-12" }, "custom", 1), { from: "2026-11-13", to: "2026-11-15" });
  });

  it("период в заголовке читается по-русски", () => {
    assert.equal(calendarRangeTitle({ from: "2026-11-16", to: "2026-11-22" }, "week"), "16—22 ноября 2026");
    assert.equal(calendarRangeTitle({ from: "2026-11-01", to: "2026-11-30" }, "month"), "ноябрь 2026");
    assert.equal(calendarRangeTitle({ from: "2026-10-28", to: "2026-11-03" }, "week"), "28 октября — 3 ноября 2026");
    assert.equal(calendarRangeTitle({ from: "2026-12-30", to: "2027-01-05" }, "week"), "30 декабря 2026 — 5 января 2027");
    assert.equal(calendarRangeTitle({ from: "2026-11-16", to: "2026-11-16" }, "custom"), "16 ноября 2026");
    assert.equal(calendarDayTitle("2026-11-16"), "16 ноября");
  });

  it("дни периода помечены выходными, сегодня и прошедшими", () => {
    const days = calendarDays({ from: "2026-11-16", to: "2026-11-22" }, "2026-11-18");
    assert.equal(days.length, 7);
    assert.deepEqual(days.map((day) => day.weekdayLabel), ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
    assert.deepEqual(days.filter((day) => day.isWeekend).map((day) => day.date), ["2026-11-21", "2026-11-22"]);
    assert.deepEqual(days.filter((day) => day.isToday).map((day) => day.date), ["2026-11-18"]);
    assert.deepEqual(days.filter((day) => day.isPast).map((day) => day.date), ["2026-11-16", "2026-11-17"]);
    // Первое число месяца подписываем, чтобы в месяце на стыке было видно границу.
    const across = calendarDays({ from: "2026-10-29", to: "2026-11-02" }, "2026-11-16");
    assert.deepEqual(across.filter((day) => day.startsMonth).map((day) => day.date), ["2026-10-29", "2026-11-01"]);
  });
});

describe("дни, которые задача занимает", () => {
  it("период целиком, иначе день выезда, иначе ничего", () => {
    assert.deepEqual(taskOccupiedRange({ periodFrom: "2026-11-16", periodTo: "2026-11-18" }), { from: "2026-11-16", to: "2026-11-18" });
    assert.deepEqual(taskOccupiedRange({ visitDate: "2026-11-17" }), { from: "2026-11-17", to: "2026-11-17" });
    // Только одна граница периода: задача занимает этот день.
    assert.deepEqual(taskOccupiedRange({ periodTo: "2026-11-19" }), { from: "2026-11-19", to: "2026-11-19" });
    assert.equal(taskOccupiedRange({}), undefined);
    // Перевёрнутый период из старых данных не ломает раскладку.
    assert.deepEqual(taskOccupiedRange({ periodFrom: "2026-11-18", periodTo: "2026-11-16" }), { from: "2026-11-16", to: "2026-11-18" });
    // Момент с временем приводим к календарному дню.
    assert.deepEqual(taskOccupiedRange({ visitDate: "2026-11-17T09:30:00.000Z" }), { from: "2026-11-17", to: "2026-11-17" });
  });

  it("перегруз начинается с трёх задач в день", () => {
    assert.equal(dayLoadLevel(0), "free");
    assert.equal(dayLoadLevel(1), "normal");
    assert.equal(dayLoadLevel(OVERLOADED_TASKS_PER_DAY - 1), "normal");
    assert.equal(dayLoadLevel(OVERLOADED_TASKS_PER_DAY), "overloaded");
    assert.equal(dayLoadLevel(7), "overloaded");
  });
});

describe("раскладка календаря по дням", () => {
  const range = { from: "2026-11-16", to: "2026-11-22" };
  const tasks: readonly CalendarTask[] = [
    // Три дня подряд у первого инженера.
    task({ id: "a", engineerId: "e-1", periodFrom: "2026-11-16", periodTo: "2026-11-18", visitDate: "2026-11-17" }),
    // Один день, он же перегружает вторник.
    task({ id: "b", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17", priority: "urgent" }),
    task({ id: "c", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17", isOverdue: true }),
    // Период начался до календаря и кончается после.
    task({ id: "d", engineerId: "e-2", periodFrom: "2026-11-10", periodTo: "2026-11-30" }),
    // Без срока.
    task({ id: "e", engineerId: "e-2" }),
    // Вне периода календаря.
    task({ id: "f", engineerId: "e-2", periodFrom: "2026-12-01", periodTo: "2026-12-02" }),
    // Без инженера.
    task({ id: "g", periodFrom: "2026-11-18", periodTo: "2026-11-18" })
  ];

  it("многодневная задача занимает все свои дни и помечает первый, последний и день выезда", () => {
    const calendar = buildEngineerCalendar({ engineers, tasks, range, today: "2026-11-16" });
    const first = calendar.rows[0];
    assert.ok(first);
    assert.equal(first.engineer.id, "e-1");
    const byDate = new Map(first.cells.map((cell) => [cell.date, cell]));
    const monday = byDate.get("2026-11-16");
    const tuesday = byDate.get("2026-11-17");
    const wednesday = byDate.get("2026-11-18");
    assert.equal(monday?.placements.length, 1);
    assert.equal(tuesday?.placements.length, 3);
    assert.equal(wednesday?.placements.length, 1);
    const mondayPlacement = monday?.placements[0];
    assert.equal(mondayPlacement?.isFirstVisibleDay, true);
    assert.equal(mondayPlacement?.isLastVisibleDay, false);
    assert.equal(mondayPlacement?.dayIndex, 1);
    assert.equal(mondayPlacement?.dayCount, 3);
    assert.equal(mondayPlacement?.isVisitDay, false);
    const visit = tuesday?.placements.find((item) => item.task.id === "a");
    assert.equal(visit?.isVisitDay, true);
    assert.equal(visit?.dayIndex, 2);
    const last = wednesday?.placements.find((item) => item.task.id === "a");
    assert.equal(last?.isLastVisibleDay, true);
  });

  it("вторник с тремя задачами перегружен, в нём сначала просрочка, потом срочная", () => {
    const calendar = buildEngineerCalendar({ engineers, tasks, range, today: "2026-11-16" });
    const first = calendar.rows[0];
    const tuesday = first?.cells.find((cell) => cell.date === "2026-11-17");
    assert.equal(tuesday?.level, "overloaded");
    assert.deepEqual(tuesday?.placements.map((item) => item.task.id), ["c", "b", "a"]);
    assert.equal(first?.summary.taskCount, 3);
    assert.equal(first?.summary.busiestDayCount, 3);
    assert.equal(first?.summary.overloadedDayCount, 1);
    assert.equal(first?.summary.busyDayCount, 3);
    // Пн—Пт без задач: четверг и пятница. Выходные в свободные рабочие дни не считаются.
    assert.equal(first?.summary.freeWorkdayCount, 2);
    assert.equal(first?.summary.overdueTaskCount, 1);
  });

  it("период за границами календаря обрезается и помечается стрелками", () => {
    const calendar = buildEngineerCalendar({ engineers, tasks, range, today: "2026-11-16" });
    const second = calendar.rows[1];
    assert.ok(second);
    assert.equal(second.cells.every((cell) => cell.placements.length === 1), true);
    const monday = second.cells[0];
    assert.equal(monday?.placements[0]?.continuesBefore, true);
    assert.equal(monday?.placements[0]?.continuesAfter, true);
    assert.equal(monday?.placements[0]?.isFirstVisibleDay, true);
    assert.equal(monday?.placements[0]?.dayIndex, 7);
    assert.equal(monday?.placements[0]?.dayCount, 21);
    // Задача целиком вне периода в календарь не попала, а задача без срока в свой список.
    assert.equal(second.summary.taskCount, 1);
    assert.deepEqual(second.undatedTasks.map((item) => item.id), ["e"]);
  });

  it("инженер без задач даёт пустую строку, задача без инженера — отдельный список", () => {
    const calendar = buildEngineerCalendar({ engineers, tasks, range, today: "2026-11-16" });
    const third = calendar.rows[2];
    assert.equal(third?.engineer.id, "e-3");
    assert.equal(third?.summary.taskCount, 0);
    assert.equal(third?.cells.length, 7);
    assert.deepEqual(calendar.unassignedTasks.map((item) => item.id), ["g"]);
    assert.equal(calendar.rows.length, 3);
    assert.equal(calendar.days.length, 7);
    // Три задачи первого, одна второго, плюс без срока и нераспределённая: многодневная
    // считается один раз, а числа на экране не спорят друг с другом.
    assert.equal(calendar.totals.taskCount, 6);
    assert.equal(calendar.totals.overloadedEngineerCount, 1);
    // Свободен только неактивный, но он в свободные не попадает.
    assert.equal(calendar.totals.freeEngineerCount, 0);
    assert.equal(calendar.totals.undatedTaskCount, 1);
    assert.equal(calendar.totals.unassignedTaskCount, 1);
  });
});

describe("занятость на период назначаемой задачи", () => {
  const range = { from: "2026-11-16", to: "2026-11-20" };
  const tasks: readonly CalendarTask[] = [
    task({ id: "a", engineerId: "e-1", periodFrom: "2026-11-16", periodTo: "2026-11-20" }),
    task({ id: "b", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17" }),
    task({ id: "c", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17" }),
    task({ id: "d", engineerId: "e-2", periodFrom: "2026-11-18", periodTo: "2026-11-18" })
  ];

  it("считает пик по дню, свободные дни и перегруз", () => {
    const load = engineerPeriodLoad({ engineers, tasks, range, today: "2026-11-16" });
    const first = load.find((item) => item.engineerId === "e-1");
    assert.equal(first?.busiestDayCount, 3);
    assert.equal(first?.busiestDay, "2026-11-17");
    assert.equal(first?.isOverloaded, true);
    assert.equal(first?.isFree, false);
    assert.equal(first?.freeWorkdayCount, 0);
    assert.equal(first?.workdayCount, 5);
    const second = load.find((item) => item.engineerId === "e-2");
    assert.equal(second?.busiestDayCount, 1);
    assert.equal(second?.freeWorkdayCount, 4);
    assert.equal(second?.isOverloaded, false);
    const third = load.find((item) => item.engineerId === "e-3");
    assert.equal(third?.isFree, true);
    assert.equal(third?.busiestDay, undefined);
  });

  it("саму назначаемую задачу в занятость не считает", () => {
    const load = engineerPeriodLoad({ engineers, tasks, range, today: "2026-11-16", ignoreTaskId: "a" });
    const first = load.find((item) => item.engineerId === "e-1");
    assert.equal(first?.busiestDayCount, 2);
    assert.equal(first?.isOverloaded, false);
    assert.equal(first?.freeWorkdayCount, 4);
  });

  it("в период только из выходных инженер не работает вовсе", () => {
    const load = engineerPeriodLoad({ engineers, tasks: [], range: { from: "2026-11-21", to: "2026-11-22" }, today: "2026-11-16" });
    assert.equal(load[0]?.worksNoDay, true);
    assert.equal(load[0]?.workdayCount, 0);
    assert.equal(periodLoadText(load[0]!), "В эти дни не работает: только выходные");
  });

  it("занятость пишется строкой для человека", () => {
    const load = engineerPeriodLoad({ engineers, tasks, range, today: "2026-11-16" });
    assert.equal(periodLoadText(load.find((item) => item.engineerId === "e-1")!), "Перегружен: 3 задачи 17 ноября · свободных дней нет");
    assert.equal(periodLoadText(load.find((item) => item.engineerId === "e-2")!), "Занят: 1 задача 18 ноября · ещё 4 свободных дня");
    assert.equal(periodLoadText(load.find((item) => item.engineerId === "e-3")!), "Свободен все 5 дней периода");
  });

  it("однодневная задача не даёт «свободен все 1 день»", () => {
    const single = engineerPeriodLoad({ engineers, tasks, range: { from: "2026-11-19", to: "2026-11-19" }, today: "2026-11-16" });
    assert.equal(periodLoadText(single.find((item) => item.engineerId === "e-2")!), "Свободен в этот день");
  });

  it("повтор задачи в ответе не красит день перегрузом", () => {
    const duplicated = buildEngineerCalendar({
      engineers,
      tasks: [tasks[1]!, tasks[1]!, tasks[1]!],
      range,
      today: "2026-11-16"
    });
    const day = duplicated.rows[0]?.cells.find((cell) => cell.date === "2026-11-17");
    assert.equal(day?.placements.length, 1);
    assert.equal(day?.level, "normal");
    assert.equal(duplicated.totals.taskCount, 1);
  });

  it("задача инженера не из сетки не теряется, а идёт в нераспределённые", () => {
    const calendar = buildEngineerCalendar({
      engineers: [engineers[0]!],
      tasks: [task({ id: "x", engineerId: "e-99", periodFrom: "2026-11-17", periodTo: "2026-11-17" })],
      range,
      today: "2026-11-16"
    });
    assert.deepEqual(calendar.unassignedTasks.map((item) => item.id), ["x"]);
    assert.equal(calendar.totals.taskCount, 1);
  });

  it("период занятости берётся у задачи, иначе день выезда, иначе сегодня", () => {
    assert.deepEqual(assignmentLoadRange({ periodFrom: "2026-11-16", periodTo: "2026-11-18" }, "2026-11-10"), { from: "2026-11-16", to: "2026-11-18" });
    assert.deepEqual(assignmentLoadRange({ visitDate: "2026-11-19" }, "2026-11-10"), { from: "2026-11-19", to: "2026-11-19" });
    assert.deepEqual(assignmentLoadRange({}, "2026-11-10"), { from: "2026-11-10", to: "2026-11-10" });
  });

  it("слишком длинный срок задачи обрезается до предела календаря", () => {
    // Годовое ТО: база не отдаст занятость за год, поэтому считаем по первым дням срока.
    const range = assignmentLoadRange({ periodFrom: "2026-01-01", periodTo: "2026-12-31" }, "2026-11-10");
    assert.equal(range.from, "2026-01-01");
    assert.equal(calendarDayCount(range), MAX_CALENDAR_DAYS);
  });
});

describe("порядок подсказки при назначении", () => {
  it("компетенция важнее занятости, перегруженный уходит вниз, но остаётся в списке", () => {
    const range = { from: "2026-11-16", to: "2026-11-20" };
    const tasks: readonly CalendarTask[] = [
      task({ id: "a", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17" }),
      task({ id: "b", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17" }),
      task({ id: "c", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17" }),
      task({ id: "d", engineerId: "e-2", periodFrom: "2026-11-18", periodTo: "2026-11-18" })
    ];
    const load = engineerPeriodLoad({ engineers, tasks, range, today: "2026-11-16" });
    const byId = new Map(load.map((item) => [item.engineerId, item]));
    const ranked = rankAssignmentCandidates([
      { engineerId: "e-1", fullName: "Антонов Антон", isAvailable: false, previouslyWorkedWithEquipment: true, load: byId.get("e-1")! },
      { engineerId: "e-2", fullName: "Борисов Борис", isAvailable: true, previouslyWorkedWithEquipment: false, load: byId.get("e-2")! },
      { engineerId: "e-3", fullName: "Вавилов Виктор", isAvailable: true, previouslyWorkedWithEquipment: false, load: byId.get("e-3")! }
    ]);
    // Перегруженный, но знакомый с прибором остаётся первым: выбор за человеком.
    assert.deepEqual(ranked.map((item) => item.engineerId), ["e-1", "e-3", "e-2"]);
  });

  it("без занятости порядок прежний: компетенция, потом свободные, потом по имени", () => {
    const ranked = rankAssignmentCandidates([
      { engineerId: "e-2", fullName: "Борисов Борис", isAvailable: false, previouslyWorkedWithEquipment: false },
      { engineerId: "e-3", fullName: "Вавилов Виктор", isAvailable: true, previouslyWorkedWithEquipment: false },
      { engineerId: "e-1", fullName: "Антонов Антон", isAvailable: true, previouslyWorkedWithEquipment: true }
    ]);
    assert.deepEqual(ranked.map((item) => item.engineerId), ["e-1", "e-3", "e-2"]);
  });

  it("кто в эти дни не работает, уходит ниже занятых", () => {
    const ranked = rankAssignmentCandidates([
      {
        engineerId: "e-1", fullName: "Антонов Антон", isAvailable: true, previouslyWorkedWithEquipment: false,
        load: { engineerId: "e-1", taskCount: 0, busiestDayCount: 0, freeWorkdayCount: 0, workdayCount: 0, isFree: true, isOverloaded: false, worksNoDay: true, overdueTaskCount: 0 }
      },
      {
        engineerId: "e-2", fullName: "Борисов Борис", isAvailable: false, previouslyWorkedWithEquipment: false,
        load: { engineerId: "e-2", taskCount: 2, busiestDayCount: 2, freeWorkdayCount: 1, workdayCount: 3, isFree: false, isOverloaded: false, worksNoDay: false, overdueTaskCount: 0 }
      }
    ]);
    assert.deepEqual(ranked.map((item) => item.engineerId), ["e-2", "e-1"]);
  });
});
