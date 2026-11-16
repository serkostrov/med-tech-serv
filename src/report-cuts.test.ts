import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cutRows, reportBarsTotal } from "./report-cuts.js";
import type { ReportCutItem } from "./m2-api.js";

const cut = (code: string, value: number): ReportCutItem => ({ code, name: `Строка ${code}`, value, closed: 0, overdue: 0 });

describe("раскладка разрезов отчёта", () => {
  it("на экране остаются первые восемь строк", () => {
    const items = Array.from({ length: 12 }, (_, index) => cut(`c${index}`, 12 - index));
    const rows = cutRows(items, false);
    assert.equal(rows.length, 8);
    assert.deepEqual(rows.map((row) => row.key), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  });

  it("код оставляем только у разрезов из справочника: по нему полоса получает цвет", () => {
    const [colored] = cutRows([cut("wear", 3)], true);
    assert.equal(colored?.code, "wear");
    const [plain] = cutRows([cut("3f0c-уникальный-id", 3)], false);
    assert.equal(plain?.code, undefined, "по идентификатору записи класс не вешаем");
    assert.equal(plain?.key, "3f0c-уникальный-id", "ключ списка всё равно нужен");
  });

  it("доли считаются от всего разреза, даже когда видна его часть", () => {
    const items = Array.from({ length: 12 }, (_, index) => cut(`c${index}`, 10));
    const rows = cutRows(items, false);
    // Восемь видимых строк по 10 — это 80, но заявок за период 120.
    assert.equal(reportBarsTotal(rows, 120), 120);
    assert.equal(Math.round((rows[0]!.value / reportBarsTotal(rows, 120)) * 100), 8);
  });

  it("без переданного итога доли считаются по видимым строкам", () => {
    assert.equal(reportBarsTotal([cut("a", 3), cut("b", 1)]), 4);
  });

  it("итог меньше показанного не опускает сумму долей ниже ста процентов", () => {
    // Разрез и шапка отчёта считаются разными функциями базы: если они разойдутся,
    // доли не должны уехать за сто процентов.
    assert.equal(reportBarsTotal([cut("a", 7), cut("b", 5)], 3), 12);
  });

  it("пустой разрез даёт ноль, а не деление на ноль", () => {
    assert.equal(reportBarsTotal([], 0), 0);
    assert.deepEqual(cutRows([], true), []);
  });
});
