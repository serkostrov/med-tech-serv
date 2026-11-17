import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changedPreferences, isPreferenceEnabled, NOTIFICATION_EVENT_OPTIONS, notificationEventsForRole, preferenceMatrix
} from "./notification-channels.js";

describe("каналы уведомлений по сотруднику", () => {
  it("сотруднику видны только события, которые ему приходят", () => {
    assert.deepEqual(notificationEventsForRole("engineer").map((item) => item.code), ["task_engineer_assigned", "task_rework_requested", "stock_reservation_ready"]);
    assert.deepEqual(notificationEventsForRole("warehouse").map((item) => item.code), ["stock_reservation_created"]);
    assert.ok(notificationEventsForRole("supervisor").some((item) => item.code === "task_overdue"));
    assert.ok(!notificationEventsForRole("coordinator").some((item) => item.code === "task_overdue"));
    assert.equal(notificationEventsForRole("sysadmin").length, NOTIFICATION_EVENT_OPTIONS.length);
    assert.equal(notificationEventsForRole(undefined).length, NOTIFICATION_EVENT_OPTIONS.length);
  });

  it("нет строки в базе — канал включён", () => {
    const matrix = preferenceMatrix([{ eventCode: "task_engineer_assigned", channel: "telegram", isEnabled: false }]);
    assert.equal(isPreferenceEnabled(matrix, "task_engineer_assigned", "telegram"), false);
    assert.equal(isPreferenceEnabled(matrix, "task_engineer_assigned", "email"), true);
    assert.equal(isPreferenceEnabled(matrix, "task_overdue", "email"), true);
  });

  it("сохраняются только изменённые галочки", () => {
    const initial = preferenceMatrix([{ eventCode: "task_engineer_assigned", channel: "telegram", isEnabled: false }]);
    assert.deepEqual(changedPreferences(initial, initial), []);
    const current = { ...initial, "task_engineer_assigned:telegram": true, "task_rework_requested:email": false };
    assert.deepEqual(changedPreferences(initial, current), [
      { eventCode: "task_engineer_assigned", channel: "telegram", isEnabled: true },
      { eventCode: "task_rework_requested", channel: "email", isEnabled: false }
    ]);
  });

  it("коды событий совпадают с каталогом событий базы", () => {
    assert.deepEqual(NOTIFICATION_EVENT_OPTIONS.map((item) => item.code).sort(), [
      "stock_reservation_created", "stock_reservation_ready", "task_application_accepted", "task_engineer_accepted",
      "task_engineer_assigned", "task_overdue", "task_rework_requested", "task_work_completed"
    ]);
  });
});
