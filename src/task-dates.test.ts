import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNotFutureCompanyMoment, companyDateText, companyDateTimeToIso, companyDay, companyDayEnd, companyDayStart, companyTime, companyToday, isFutureCompanyDate, isFutureCompanyMoment, taskCalendarDate, taskPeriodProblem } from "./task-dates.js";

describe("task calendar dates", () => {
  it("keeps midnight on the selected Moscow calendar day", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Europe/Moscow";
    try {
      assert.equal(taskCalendarDate("2026-08-20"), "2026-08-20");
      assert.equal(new Date("2026-08-20T00:00").toISOString().slice(0, 10), "2026-08-19");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("rejects impossible and date-time values", () => {
    assert.throws(() => taskCalendarDate("2026-02-30"), /существующую/u);
    assert.throws(() => taskCalendarDate("2026-08-20T00:00"), /календарную дату/u);
  });
});

describe("время работ по часам компании", () => {
  it("время из акта записывается и показывается по Москве, где бы ни было устройство", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Asia/Novosibirsk";
    try {
      const iso = companyDateTimeToIso("2026-11-13", "09:30");
      assert.equal(iso, "2026-11-13T06:30:00.000Z");
      assert.equal(companyTime(iso), "09:30");
      assert.equal(companyDateText("2026-11-13T22:30:00.000Z"), "14.11.2026");
      assert.equal(companyTime(undefined), "");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
  });

  it("сутки для отчёта начинаются и кончаются по Москве", () => {
    const previousTimezone = process.env.TZ;
    // Пояс западнее Москвы: на машине разработчика (+07) проверка идёт в другую сторону.
    process.env.TZ = "America/Los_Angeles";
    try {
      assert.equal(companyDayStart("2026-11-13"), "2026-11-12T21:00:00.000Z");
      assert.equal(companyDayEnd("2026-11-13"), "2026-11-13T20:59:59.999Z");
      assert.equal(companyDay("2026-11-12T21:30:00.000Z"), "2026-11-13", "00:30 по Москве уже следующий день");
      assert.equal(companyToday(new Date("2026-11-12T21:30:00.000Z")), "2026-11-13");
      assert.equal(companyToday(new Date("2026-11-12T20:59:00.000Z")), "2026-11-12");
      assert.equal(companyDayStart("не дата"), undefined);
      assert.equal(companyDayEnd(""), undefined);
      assert.equal(companyDayStart("2026-02-30"), undefined, "несуществующий день не переезжает в март");
      assert.equal(companyDayEnd("2026-11-31"), undefined);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
    }
  });
});

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

describe("срок задачи (аудит 17.11, № 77, 78)", () => {
  it("перевёрнутый срок и срок раньше вызова не принимаются", () => {
    assert.equal(taskPeriodProblem({ periodFrom: "2026-11-20", periodTo: "2026-11-18" }), "Начало периода не может быть позже конца");
    assert.equal(taskPeriodProblem({ periodFrom: "2020-01-01", periodTo: "2020-01-02", callDate: "2026-11-17" }),
      "Срок «по» 02.01.2020 раньше даты вызова 17.11.2026: работа не могла закончиться раньше, чем поступила заявка");
    assert.equal(taskPeriodProblem({ periodFrom: "2026-11-10", periodTo: "2026-11-20", callDate: "2026-11-17" }), "",
      "начало раньше вызова допустимо: задача из плана ТО внутри своего периода");
    assert.equal(taskPeriodProblem({ periodFrom: "", periodTo: "2026-11-20" }), "Укажите период выполнения: даты «с» и «по»");
  });
});

