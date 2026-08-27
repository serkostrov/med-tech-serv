import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskCalendarDate } from "./task-dates.js";

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
