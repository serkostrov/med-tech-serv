import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  formatDisplayDate,
  formatDisplayTime,
  formatIsoCalendarDate,
  parseDisplayDate,
  parseDisplayTime
} from "./date-format.js";

describe("russian date format", () => {
  it("formats calendar dates as dd.mm.yyyy without timezone shift", () => {
    assert.equal(formatIsoCalendarDate("2026-08-27"), "27.08.2026");
    assert.equal(formatDisplayDate("2026-01-05"), "05.01.2026");
    assert.equal(formatDisplayDate(new Date(2026, 7, 27, 9, 5), true), "27.08.2026, 09:05");
    assert.equal(formatDisplayTime(new Date(2026, 7, 27, 9, 5)), "09:05");
  });

  it("parses typed russian dates into ISO calendar values", () => {
    assert.equal(parseDisplayDate("27.08.2026"), "2026-08-27");
    assert.equal(parseDisplayDate("5.1.26"), "2026-01-05");
    assert.equal(parseDisplayDate(""), "");
    assert.equal(parseDisplayDate("32.01.2026"), null);
  });

  it("keeps 24-hour time as hh:mm", () => {
    assert.equal(parseDisplayTime("9:05"), "09:05");
    assert.equal(parseDisplayTime("24:00"), null);
  });

  it("replaces native date inputs with the shared picker", async () => {
    const files = await Promise.all([
      "App.tsx",
      "OperationsPages.tsx",
      "MaintenancePlan.tsx"
    ].map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")));
    const source = files.join("\n");
    assert.doesNotMatch(source, /type="date"/u);
    assert.doesNotMatch(source, /type="datetime-local"/u);
    assert.match(source, /DatePicker/u);
    assert.match(source, /DateTimePicker/u);
  });
});
