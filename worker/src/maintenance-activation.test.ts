import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activateDueMaintenanceTasks,
  maintenanceActivationConfig,
  maintenanceActivationCutoff,
  PostgresMaintenanceActivationRepository,
  type MaintenanceActivationRepository
} from "./maintenance-activation.js";

describe("maintenance task activation", () => {
  it("uses the fixed Moscow schedule and period start rule by default", () => {
    assert.deepEqual(maintenanceActivationConfig({}), {
      cron: "0 0 * * *",
      timeZone: "Europe/Moscow",
      rule: "period_start",
      leadDays: 0
    });
  });

  it("switches the calendar date exactly at Moscow midnight", () => {
    const config = maintenanceActivationConfig({});
    assert.equal(maintenanceActivationCutoff(new Date("2026-08-18T20:59:59.999Z"), config), "2026-08-18");
    assert.equal(maintenanceActivationCutoff(new Date("2026-08-18T21:00:00.000Z"), config), "2026-08-19");
  });

  it("supports a configurable lead time across month, year and leap-day boundaries", () => {
    const config = maintenanceActivationConfig({
      MAINTENANCE_ACTIVATION_RULE: "days_before_period_start",
      MAINTENANCE_ACTIVATION_LEAD_DAYS: "2"
    });
    assert.equal(maintenanceActivationCutoff(new Date("2026-12-30T21:00:00.000Z"), config), "2027-01-02");
    assert.equal(maintenanceActivationCutoff(new Date("2028-02-27T21:00:00.000Z"), config), "2028-03-01");
  });

  it("rejects contradictory and invalid activation settings", () => {
    assert.throws(() => maintenanceActivationConfig({ MAINTENANCE_ACTIVATION_LEAD_DAYS: "1" }), /must be 0/u);
    assert.throws(() => maintenanceActivationConfig({ MAINTENANCE_ACTIVATION_RULE: "unknown" }), /period_start/u);
    assert.throws(() => maintenanceActivationConfig({
      MAINTENANCE_ACTIVATION_RULE: "days_before_period_start",
      MAINTENANCE_ACTIVATION_LEAD_DAYS: "366"
    }), /0 to 365/u);
    assert.throws(() => maintenanceActivationConfig({ MAINTENANCE_ACTIVATION_TIME_ZONE: "Mars/Olympus" }), /IANA/u);
  });

  it("activates only due planned tasks and is idempotent on repeat", async () => {
    const tasks = [
      { id: "before", periodFrom: "2026-08-17", status: "planned" },
      { id: "boundary", periodFrom: "2026-08-18", status: "planned" },
      { id: "future", periodFrom: "2026-08-19", status: "planned" },
      { id: "already-new", periodFrom: "2026-08-18", status: "new" }
    ];
    const calls: Array<{ readonly cutoffDate: string; readonly activatedAt: string }> = [];
    const repository: MaintenanceActivationRepository = {
      async activateDue(cutoffDate, activatedAt) {
        calls.push({ cutoffDate, activatedAt });
        const activated = tasks.filter((task) => task.status === "planned" && task.periodFrom <= cutoffDate);
        for (const task of activated) task.status = "new";
        return activated.map((task) => task.id);
      }
    };
    const now = new Date("2026-08-18T09:00:00.000Z");
    const first = await activateDueMaintenanceTasks(repository, maintenanceActivationConfig({}), now);
    const second = await activateDueMaintenanceTasks(repository, maintenanceActivationConfig({}), now);

    assert.deepEqual(first.activatedTaskIds, ["before", "boundary"]);
    assert.deepEqual(second.activatedTaskIds, []);
    assert.equal(tasks.find((task) => task.id === "future")?.status, "planned");
    assert.equal(tasks.find((task) => task.id === "already-new")?.status, "new");
    assert.deepEqual(calls, [
      { cutoffDate: "2026-08-18", activatedAt: "2026-08-18T09:00:00.000Z" },
      { cutoffDate: "2026-08-18", activatedAt: "2026-08-18T09:00:00.000Z" }
    ]);
  });

  it("calls the restricted PostgreSQL command with explicit cutoff and instant", async () => {
    const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
    const repository = new PostgresMaintenanceActivationRepository({
      async executeSql(text, values = []) {
        calls.push({ text, values });
        return { rows: [{ task_id: "task-due-1" }, { task_id: "task-due-2" }] };
      }
    });
    const result = await repository.activateDue("2026-08-18", "2026-08-17T21:00:00.000Z");
    assert.deepEqual(result, ["task-due-1", "task-due-2"]);
    assert.match(calls[0]?.text ?? "", /public\.activate_due_maintenance_tasks\(\$1::date, \$2::timestamptz\)/u);
    assert.deepEqual(calls[0]?.values, ["2026-08-18", "2026-08-17T21:00:00.000Z"]);
  });
});
