import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineerCalendarGrid } from "./EngineerCalendar.js";
import { buildEngineerCalendar, type CalendarEngineer, type CalendarTask } from "./engineer-calendar.js";

const engineers: readonly CalendarEngineer[] = [
  { id: "e-1", fullName: "Антонов Антон", isActive: true },
  { id: "e-2", fullName: "Борисов Борис", isActive: false }
];

const tasks: readonly CalendarTask[] = [
  // Три дня подряд: номер и название стоят в первом дне, дальше полоска.
  { id: "a", number: "З-000101", title: "ТО анализатора", status: "assigned", engineerId: "e-1", periodFrom: "2026-11-16", periodTo: "2026-11-18", visitDate: "2026-11-17", siteName: "ГКБ № 1", equipmentLabel: "Mindray BC-6800 · SN-1" },
  { id: "b", number: "З-000102", title: "Срочный ремонт", status: "in_progress", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17", priority: "urgent" },
  { id: "c", number: "З-000103", title: "Диагностика", status: "assigned", engineerId: "e-1", periodFrom: "2026-11-17", periodTo: "2026-11-17", isOverdue: true },
  // Историческая задача без срока: на день её поставить нельзя.
  { id: "d", number: "З-000090", title: "Проверка заземления", status: "assigned", engineerId: "e-2" }
];

function markup(from = "2026-11-16", to = "2026-11-22"): string {
  const calendar = buildEngineerCalendar({ engineers, tasks, range: { from, to }, today: "2026-11-17" });
  return renderToStaticMarkup(<EngineerCalendarGrid calendar={calendar} onOpenTask={() => undefined} title="16—22 ноября 2026" />);
}

describe("сетка календаря загрузки", () => {
  it("рисует дни недели, выходные и сегодняшний день", () => {
    const html = markup();
    assert.match(html, /Загрузка инженеров: 16—22 ноября 2026/u);
    assert.match(html, /engineer-calendar__day is-weekend/u);
    assert.match(html, /engineer-calendar__day[^"]*is-today/u);
    assert.match(html, />Пн</u);
    assert.match(html, />Вс</u);
    // Месяц периода — в заголовке; у первого дня числа на одной линии с остальными, без подписи
    // месяца под числом (вторая встреча 18.11: «1 ноября съехал»).
    assert.doesNotMatch(html, /engineer-calendar__month/u);
    // Неделя на стыке месяцев: месяц подписан у 1-го числа в строке дня недели.
    assert.match(markup("2026-11-28", "2026-12-04"), /engineer-calendar__month">Вт · дек</u);
  });

  it("многодневная задача — одна полоса через свои дни, название один раз", () => {
    const html = markup();
    // Встреча 18.11: «день 15 из 16» в каждой клетке выглядело плохо. Теперь одна полоса.
    assert.equal(html.match(/calendar-bar__number">З-000101</gu)?.length, 1);
    assert.equal(html.match(/calendar-bar__title">ТО анализатора</gu)?.length, 1);
    assert.match(html, /grid-column:1 \/ 4[^"]*"[^>]*title="З-000101/u);
    // Черты дня выезда нет (лишнее визуально), подсказка рассказывает срок, выезд и площадку.
    assert.doesNotMatch(html, /calendar-bar__visit/u);
    assert.match(html, /выезд 17\.11\.2026/u);
    assert.match(html, /ГКБ № 1/u);
    assert.doesNotMatch(html, /день 2 из 3/u);
  });

  it("задачи в одни дни встают друг под другом, а не налезают", () => {
    const html = markup();
    // Просроченная выше срочной: важное сверху, как и раньше в клетке дня.
    assert.match(html, /grid-column:2 \/ 3;grid-row:2"[^>]*title="З-000103/u);
    assert.match(html, /grid-column:2 \/ 3;grid-row:3"[^>]*title="З-000102/u);
  });

  it("дни без заливки перегруза, у фамилии — только значки бед, без цифр", () => {
    const html = markup();
    // Вторая встреча 18.11: жёлтая подложка перегруза путала, о перегрузе говорит значок у фамилии.
    assert.doesNotMatch(html, /is-overloaded/u);
    assert.match(html, />Перегруз</u);
    assert.match(html, />Просрочка</u);
    assert.match(html, /calendar-bar--overdue/u);
    // Встреча 18.11: «пик», «окон», «Свободен» убраны.
    assert.doesNotMatch(html, /пик|окон|Свободен/u);
  });

  it("задача без срока стоит в своём столбце, а не в каком-нибудь дне", () => {
    const html = markup();
    assert.match(html, /Без срока/u);
    assert.match(html, /calendar-bar--undated/u);
    assert.match(html, /З-000090/u);
    // Неактивный инженер в сетке помечен.
    assert.match(html, /engineer-calendar__name is-inactive/u);
  });

  it("столбца «Без срока» нет, если таких задач нет", () => {
    const calendar = buildEngineerCalendar({ engineers, tasks: tasks.filter((task) => task.id !== "d"), range: { from: "2026-11-16", to: "2026-11-22" }, today: "2026-11-17" });
    const html = renderToStaticMarkup(<EngineerCalendarGrid calendar={calendar} onOpenTask={() => undefined} title="неделя" />);
    assert.doesNotMatch(html, /Без срока/u);
    assert.doesNotMatch(html, /engineer-calendar__grid--undated/u);
  });

  it("неназначенные задачи — первой строкой сетки, по своим дням", () => {
    const calendar = buildEngineerCalendar({
      engineers,
      tasks: [...tasks, { id: "e", number: "З-000104", title: "Без инженера", status: "new", periodFrom: "2026-11-19", periodTo: "2026-11-20" }],
      range: { from: "2026-11-16", to: "2026-11-22" },
      today: "2026-11-17"
    });
    const html = renderToStaticMarkup(<EngineerCalendarGrid calendar={calendar} onOpenTask={() => undefined} title="неделя" />);
    assert.ok(html.indexOf("Не назначены") < html.indexOf("Антонов Антон"));
    assert.match(html, /engineer-calendar__row--unassigned/u);
    assert.match(html, /grid-column:4 \/ 6;grid-row:1"[^>]*title="З-000104/u);
  });

  it("период, начавшийся раньше окна, помечен срезанным краем", () => {
    // Окно со среды: трёхдневная задача началась до него и видна одним днём.
    const html = markup("2026-11-18", "2026-11-24");
    assert.match(html, /calendar-bar--from-before/u);
    // У плашки без срока подсказка читается целиком, а не одним номером.
    assert.match(html, /aria-label="З-000090 · Проверка заземления · Назначена · срок не задан"/u);
  });

  it("в длинном периоде сетка уплотняется", () => {
    assert.doesNotMatch(markup(), /engineer-calendar__grid--dense/u);
    assert.match(markup("2026-11-01", "2026-11-30"), /engineer-calendar__grid--dense/u);
  });
});
