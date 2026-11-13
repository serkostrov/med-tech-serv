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

/** Событие склада: в payload есть сам резерв (0001), задачи в нём нет. */
const stockEvent: BusinessEvent = {
  id: toDomainId("00000000-0000-4000-8000-000000000040"),
  idempotencyKey: "stock_reservation_created:test-40:1",
  eventCode: "stock_reservation_created",
  eventVersion: 1,
  aggregateType: "stock_reservation",
  aggregateId: toDomainId("00000000-0000-4000-8000-000000000239"),
  occurredAt: toIsoDateTime("2026-08-18T14:00:00.000Z"),
  payload: { reservationId: "00000000-0000-4000-8000-000000000239", reservationNumber: "Р-000012" }
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
    // У задачного события резерва нет: поле остаётся пустым.
    assert.equal(commands[0]?.reservationId, undefined);
  });

  it("письмо по резерву: текст из складского шаблона, ссылка на задачу резерва", async () => {
    const database = {
      async executeSql() {
        return { rows: [{
          recipient_user_id: "00000000-0000-4000-8000-000000000339",
          recipient_address: "store1@example.test",
          recipient_name: "Кладовщик один",
          subject_template: "Новый резерв {{reservationNumber}}",
          body_template: "Здравствуйте, {{recipientName}}!\n\nНовый резерв {{reservationNumber}}: {{partName}} {{partArticle}}, {{quantity}} шт., {{condition}}. Задача {{taskNumber}} «{{taskTitle}}», {{siteName}}.\n\nКарточка задачи: {{taskUrl}}",
          allowed_variables: [
            "recipientName", "reservationNumber", "partArticle", "partName", "quantity",
            "condition", "taskNumber", "taskTitle", "siteName", "taskUrl"
          ],
          task_id: "00000000-0000-4000-8000-000000000139",
          variables: {
            recipientName: "Кладовщик один", reservationNumber: "Р-000012", partArticle: "115-107131-00",
            partName: "клапан", quantity: "1", condition: "новая", taskNumber: "З-000041",
            taskTitle: "Ремонт BS-620", siteName: "ГКБ № 1"
          }
        }] };
      }
    };
    const commands = await new PostgresEmailEventDeliveryPlanner(database, "https://medtech.example.test/").plan(stockEvent);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.subject, "Новый резерв Р-000012");
    assert.match(commands[0]?.body ?? "", /Новый резерв Р-000012: клапан 115-107131-00, 1 шт\., новая\. Задача З-000041 «Ремонт BS-620», ГКБ № 1\./u);
    assert.match(commands[0]?.body ?? "", /https:\/\/medtech\.example\.test\/tasks\/00000000-0000-4000-8000-000000000139/u);
    // Доставка в журнале ссылается на резерв: номер берётся из payload события.
    assert.equal(commands[0]?.reservationId, "00000000-0000-4000-8000-000000000239");
    assert.equal(commands[0]?.idempotencyKey, `${stockEvent.idempotencyKey}:email:00000000-0000-4000-8000-000000000339`);
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
