import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toDomainId, toIsoDateTime, type BusinessEvent } from "./domain.js";
import { enqueueOverdueTaskEvents, PostgresEmailEventDeliveryPlanner } from "./email-planner.js";

const event: BusinessEvent = {
  id: toDomainId("00000000-0000-4000-8000-000000000039"),
  idempotencyKey: "task_engineer_assigned:test-39:1",
  eventCode: "task_engineer_assigned",
  eventVersion: 1,
  aggregateType: "task",
  aggregateId: toDomainId("00000000-0000-4000-8000-000000000139"),
  occurredAt: toIsoDateTime("2026-08-18T14:00:00.000Z"),
  payload: {}
};

describe("e-mail event planner", () => {
  it("renders an editable template into an idempotent e-mail command", async () => {
    const database = {
      async executeSql() {
        return { rows: [{
          recipient_user_id: "00000000-0000-4000-8000-000000000239",
          recipient_address: "engineer39@example.test",
          recipient_name: "Тестовый инженер",
          subject_template: "Назначена {{taskNumber}}",
          body_template: "Здравствуйте, {{recipientName}}. Открыть: {{taskUrl}}",
          allowed_variables: ["taskNumber", "recipientName", "taskUrl"],
          task_id: "00000000-0000-4000-8000-000000000139",
          variables: { taskNumber: "З-ТЕСТ-039", recipientName: "Тестовый инженер" }
        }] };
      }
    };
    const commands = await new PostgresEmailEventDeliveryPlanner(database, "https://medtech.example.test/").plan(event);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.recipientAddress, "engineer39@example.test");
    assert.equal(commands[0]?.subject, "Назначена З-ТЕСТ-039");
    assert.match(commands[0]?.body ?? "", /https:\/\/medtech\.example\.test\/tasks\/00000000/u);
    assert.equal(commands[0]?.idempotencyKey, `${event.idempotencyKey}:email:00000000-0000-4000-8000-000000000239`);
  });

  it("invokes the idempotent overdue scanner at the database seam", async () => {
    const calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
    const database = {
      async executeSql(text: string, values?: readonly unknown[]) {
        calls.push({ text, ...(values ? { values } : {}) });
        return { rows: [{ inserted_count: 2 }] };
      }
    };
    assert.equal(await enqueueOverdueTaskEvents(database, new Date("2026-08-18T14:00:00.000Z")), 2);
    assert.match(calls[0]?.text ?? "", /enqueue_overdue_task_events/u);
    assert.deepEqual(calls[0]?.values, ["2026-08-18T14:00:00.000Z"]);
  });
});
