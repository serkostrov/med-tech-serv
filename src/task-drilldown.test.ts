import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cutDrillDown, drillPeriodText, metricDrillDown } from "./task-drilldown.js";

const period = { from: "2026-11-01", to: "2026-11-16" };

describe("переход из отчёта в задачи", () => {
  it("цифры шапки ведут в задачи того же периода по дню создания", () => {
    assert.deepEqual(metricDrillDown("overdue", period), { title: "Просроченные", createdFrom: "2026-11-01", createdTo: "2026-11-16", overdue: true });
    assert.deepEqual(metricDrillDown("closed", period).status, "closed");
    assert.equal(metricDrillDown("open", period).openOnly, true);
    assert.deepEqual(metricDrillDown("all", period), { title: "Все заявки", createdFrom: "2026-11-01", createdTo: "2026-11-16" });
  });

  it("полоса разреза ведёт в задачи с этим значением", () => {
    assert.equal(cutDrillDown("work_type", { code: "diagnostics", name: "Диагностика" }, period)?.workTypeCode, "diagnostics");
    assert.equal(cutDrillDown("work_type", { code: "diagnostics", name: "Диагностика" }, period)?.title, "Вид работ: Диагностика");
    assert.equal(cutDrillDown("status", { code: "in_progress", name: "В работе" }, period)?.status, "in_progress");
    assert.equal(cutDrillDown("site", { code: "site-1", name: "ГКБ № 1" }, period)?.siteId, "site-1");
  });

  it("гарантия: Г, Н и «не отмечено» становятся фильтром гарантии", () => {
    assert.equal(cutDrillDown("modifier", { code: "G", name: "Г" }, period)?.guarantee, "G");
    assert.equal(cutDrillDown("modifier", { code: "N", name: "Н" }, period)?.guarantee, "N");
    assert.equal(cutDrillDown("modifier", { code: "unset", name: "Не отмечено" }, period)?.guarantee, "none");
  });

  it("«не указано» у причины и инженера находится, у прибора и площадки перехода нет", () => {
    assert.equal(cutDrillDown("reason", { code: "unset", name: "Причина не указана" }, period)?.reasonCode, "none");
    assert.equal(cutDrillDown("engineer", { code: "unset", name: "Инженер не назначен" }, period)?.engineerId, "none");
    // Откуда задача (0070): план ТО и разовая заявка ведут в список с этим признаком.
    assert.equal(cutDrillDown("source", { code: "plan", name: "Из плана ТО" }, period)?.maintenancePlan, true);
    assert.equal(cutDrillDown("source", { code: "single", name: "Разовая заявка" }, period)?.maintenancePlan, false);
    assert.equal(cutDrillDown("source", { code: "single", name: "Разовая заявка" }, period)?.title, "Откуда задача: Разовая заявка");
    assert.equal(cutDrillDown("equipment", { code: "unset", name: "Прибор не указан" }, period), null);
    assert.equal(cutDrillDown("site", { code: "unset", name: "Площадка не указана" }, period), null);
  });

  it("месяц обрезается периодом отчёта", () => {
    const november = cutDrillDown("month", { code: "2026-11", name: "ноя 2026" }, period);
    assert.equal(november?.createdFrom, "2026-11-01");
    assert.equal(november?.createdTo, "2026-11-16");
    const october = cutDrillDown("month", { code: "2026-10", name: "окт 2026" }, { from: "2026-06-01", to: "2026-11-16" });
    assert.deepEqual([october?.createdFrom, october?.createdTo], ["2026-10-01", "2026-10-31"]);
    const february = cutDrillDown("month", { code: "2028-02", name: "фев 2028" }, { from: "2028-01-01", to: "2028-12-31" });
    assert.equal(february?.createdTo, "2028-02-29");
  });

  it("период под заголовком списка", () => {
    assert.equal(drillPeriodText({ createdFrom: "2026-11-01", createdTo: "2026-11-16" }), "созданы 01.11.2026 — 16.11.2026");
  });
});
