import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNotFutureCompanyMoment, companyToday, isFutureCompanyDate, isFutureCompanyMoment } from "./task-dates.js";

// 16 ноября 2026 года, 10:00 по Москве.
const now = new Date("2026-11-16T07:00:00.000Z");

describe("даты не из будущего", () => {
  it("знает сегодняшний день по часам компании", () => {
    assert.equal(companyToday(now), "2026-11-16");
  });

  it("не пускает дату вызова из будущего", () => {
    assert.equal(isFutureCompanyDate("2035-01-01", now), true);
    assert.equal(isFutureCompanyDate("2026-11-17", now), true);
  });

  it("сегодня и прошлое пропускает", () => {
    assert.equal(isFutureCompanyDate("2026-11-16", now), false);
    assert.equal(isFutureCompanyDate("2026-11-11", now), false);
    assert.equal(isFutureCompanyDate("2018-06-12", now), false);
  });

  it("пустую и несуществующую дату не считает будущей: о них говорят другие проверки", () => {
    assert.equal(isFutureCompanyDate("", now), false);
    assert.equal(isFutureCompanyDate("2026-02-30", now), false);
  });

  it("событие прибора из 2030 года отклоняется с понятным текстом", () => {
    assert.equal(isFutureCompanyMoment("2030-01-01T09:00:00.000Z", now), true);
    assert.throws(
      () => assertNotFutureCompanyMoment("2030-01-01T09:00:00.000Z", "Дата события", now),
      /Дата события не может быть из будущего/u
    );
  });

  it("событие сегодняшним вечером проходит, даже если часы устройства спешат", () => {
    assert.equal(isFutureCompanyMoment("2026-11-16T20:30:00.000Z", now), false);
    assert.doesNotThrow(() => assertNotFutureCompanyMoment("2026-11-16T20:30:00.000Z", "Дата события", now));
  });
});
