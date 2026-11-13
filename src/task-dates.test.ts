import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { companyDateText, companyDateTimeToIso, companyTime, taskCalendarDate } from "./task-dates.js";

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
});
