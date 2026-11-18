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
    // Первый день периода подписан месяцем.
    assert.match(html, />ноя</u);
  });

  it("многодневная задача подписана в каждом своём дне: в первом — название, дальше — какой это день", () => {
    const html = markup();
    // Встреча 18.11: пустые полоски продолжения были непонятны. Номер — в каждом дне задачи,
    // название — один раз, в первом дне, в остальных — «день 2 из 3».
    assert.equal(html.match(/calendar-task__number">З-000101</gu)?.length, 3);
    assert.equal(html.match(/calendar-task__title">ТО анализатора</gu)?.length, 1);
    assert.match(html, /calendar-task__day">день 2 из 3</u);
    assert.match(html, /calendar-task--continued/u);
    // День выезда помечен, подсказка рассказывает про день 2 из 3 и площадку.
    assert.match(html, /calendar-task--visit/u);
    assert.match(html, /день 2 из 3/u);
    assert.match(html, /ГКБ № 1/u);
  });

  it("день с тремя задачами помечен перегрузом, а строка — значком", () => {
    const html = markup();
    assert.match(html, /engineer-calendar__cell engineer-calendar__cell--overloaded/u);
    assert.match(html, /3 задачи · пик 3 · окон 2/u);
    // Просрочка и перегруз — разные беды, оба значка на месте.
    assert.match(html, />Перегружен</u);
    assert.match(html, />Есть просрочки</u);
    assert.match(html, /calendar-task--overdue/u);
  });

  it("задача без срока стоит в своём столбце, а не в каком-нибудь дне", () => {
    const html = markup();
    assert.match(html, /Без срока/u);
    assert.match(html, /calendar-task--undated/u);
    assert.match(html, /З-000090/u);
    // Неактивный инженер в сетке помечен.
    assert.match(html, /engineer-calendar__name is-inactive/u);
  });

  it("период, начавшийся раньше окна, помечен и без подписи", () => {
    // Окно со среды: трёхдневная задача началась до него и видна с обрезанным краем.
    const html = markup("2026-11-18", "2026-11-24");
    assert.match(html, /calendar-task--from-before/u);
    assert.match(html, /день 3 из 3/u);
    // У плашки без срока подсказка читается целиком, а не одним номером.
    assert.match(html, /aria-label="З-000090 · Проверка заземления · Назначена · срок не задан"/u);
  });

  it("в длинном периоде клетки становятся полосками", () => {
    assert.doesNotMatch(markup(), /engineer-calendar__grid--dense/u);
    assert.match(markup("2026-11-01", "2026-11-30"), /engineer-calendar__grid--dense/u);
  });
});
