import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { MAINTENANCE_MONTHS, formatMaintenancePeriod, maintenancePlanStatusLabel } from "./MaintenancePlan.js";

describe("maintenance plan presentation", () => {
  it("uses all calendar months and Russian task-plan statuses", () => {
    assert.equal(MAINTENANCE_MONTHS.length, 12);
    assert.equal(MAINTENANCE_MONTHS[0], "Янв");
    assert.equal(MAINTENANCE_MONTHS[11], "Дек");
    assert.equal(maintenancePlanStatusLabel.planned, "Запланировано");
    assert.equal(maintenancePlanStatusLabel.generated, "Задача создана");
  });

  it("shows both years for a crossing maintenance period", () => {
    const label = formatMaintenancePeriod("2026-12-20", "2027-01-05");
    assert.match(label, /2026/u);
    assert.match(label, /2027/u);
  });

  it("asks for the device first and uses full period field labels", async () => {
    const source = await readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8");
    assert.match(source, /Сначала выберите прибор/u);
    assert.match(source, /Начало\s+<DatePicker/u);
    assert.match(source, /Окончание\s+<DatePicker/u);
    assert.match(source, /Удалить период/u);
    assert.match(source, /MAX_ANNUAL_MAINTENANCE_PERIODS/u);
  });

  it("uses the shared card header for the schedule", async () => {
    const [source, css] = await Promise.all([
      readFile(new URL("./MaintenancePlan.tsx", import.meta.url), "utf8"),
      readFile(new URL("./styles.css", import.meta.url), "utf8")
    ]);
    assert.match(source, /<CardHeader/u);
    assert.match(source, /title=\{`График на \$\{year\} год`\}/u);
    assert.doesNotMatch(source, /maintenance-section-heading/u);
    assert.doesNotMatch(css, /\.maintenance-section-heading\s*\{/u);
    assert.match(css, /\.maintenance-toolbar\s+\.page-tabs:last-child\s*\{[^}]*margin-left:\s*auto/su);
  });
});
