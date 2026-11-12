import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelDeliveryCommand, OutboxSqlExecutor } from "./outbox.js";
import { PostgresEmailTaskCardSource } from "./smtp.js";
import { formatTaskPeriod, loadTaskCardFromPlan, taskCardFromVariables, taskStageLook } from "./task-card.js";
import { PostgresTelegramTaskCardSource } from "./telegram.js";

const variables = {
  recipientName: "Пётр Андреевич",
  taskNumber: "З-000007",
  taskTitle: "Замена датчика давления",
  siteName: "ГКБ №1, КДЛ",
  engineerName: "Иванов П. А.",
  periodFrom: "2026-11-12",
  periodTo: "2026-11-13",
  reworkComment: "Нет фото акта",
  taskId: "00000000-0000-4000-8000-000000000139"
};

function planDatabase(rows: readonly Record<string, unknown>[]): OutboxSqlExecutor & { readonly queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> } {
  const queries: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  return {
    queries,
    executeSql: async (text, values) => {
      queries.push({ text, ...(values ? { values } : {}) });
      return { rows };
    }
  };
}

const delivery: ChannelDeliveryCommand = {
  idempotencyKey: "task_rework_requested:t1:1:email:u1",
  eventCode: "task_rework_requested",
  channel: "email",
  recipientAddress: " engineer@clinic.example.test ",
  subject: "Задача З-000007 возвращена на доработку",
  body: "Текст",
  taskId: "00000000-0000-4000-8000-000000000139",
  outboxEventId: "00000000-0000-4000-8000-000000000001"
};

describe("данные карточки задачи при отправке", () => {
  it("почта: строку получателя находит по номеру события без учёта регистра и пробелов", async () => {
    const database = planDatabase([
      { recipient_address: "other@clinic.example.test", variables: { ...variables, recipientName: "Другой" } },
      { recipient_address: "Engineer@Clinic.example.test", variables }
    ]);
    const card = await new PostgresEmailTaskCardSource(database).load(delivery);
    assert.deepEqual(card, {
      eventCode: "task_rework_requested",
      recipientName: "Пётр Андреевич",
      taskNumber: "З-000007",
      taskTitle: "Замена датчика давления",
      siteName: "ГКБ №1, КДЛ",
      engineerName: "Иванов П. А.",
      periodFrom: "2026-11-12",
      periodTo: "2026-11-13",
      reworkComment: "Нет фото акта"
    });
    assert.equal(database.queries.length, 1);
    assert.match(database.queries[0]?.text ?? "", /FROM public\.load_email_event_plan\(\$1::uuid\)/u);
    assert.deepEqual(database.queries[0]?.values, ["00000000-0000-4000-8000-000000000001"]);
  });

  it("Telegram: номер чата сравнивается точно, данные из плана Telegram", async () => {
    const database = planDatabase([{ recipient_address: "123456789", variables }]);
    const telegramDelivery = { ...delivery, channel: "telegram" as const, recipientAddress: " 123456789 " };
    const card = await new PostgresTelegramTaskCardSource(database).load(telegramDelivery);
    assert.equal(card?.taskTitle, "Замена датчика давления");
    assert.match(database.queries[0]?.text ?? "", /FROM public\.load_telegram_event_plan\(\$1::uuid\)/u);
    assert.equal(await loadTaskCardFromPlan(database, "telegram", { ...telegramDelivery, recipientAddress: "1234567890" }), undefined);
  });

  it("нет номера события, строки получателя или переменных — карточки нет", async () => {
    const database = planDatabase([
      { recipient_address: "engineer@clinic.example.test", variables: ["не объект"] },
      { recipient_address: "nobody@clinic.example.test", variables: null }
    ]);
    const { outboxEventId: _omitted, ...withoutEvent } = delivery;
    assert.equal(await loadTaskCardFromPlan(database, "email", withoutEvent), undefined);
    assert.equal(database.queries.length, 0, "без номера события в базу не ходим");
    assert.equal(await loadTaskCardFromPlan(database, "email", delivery), undefined);
    assert.equal(await loadTaskCardFromPlan(database, "email", { ...delivery, recipientAddress: "nobody@clinic.example.test" }), undefined);
    assert.equal(await loadTaskCardFromPlan(database, "email", { ...delivery, recipientAddress: "missing@clinic.example.test" }), undefined);
  });

  it("пустые и нестроковые переменные пропускает", () => {
    assert.deepEqual(
      taskCardFromVariables("task_overdue", { taskTitle: "  ", taskNumber: 5, siteName: "ГКБ", engineerName: null, extra: "x" }),
      { eventCode: "task_overdue", siteName: "ГКБ" }
    );
  });

  it("срок в письме с полным названием месяца", () => {
    assert.equal(formatTaskPeriod("2026-11-12", "2026-11-13", "Europe/Moscow", "long"), "12–13 ноября");
    assert.equal(formatTaskPeriod("2026-11-12", "2026-11-12", "Europe/Moscow", "long"), "12 ноября");
    assert.equal(formatTaskPeriod("2026-11-28", "2026-12-03", "Europe/Moscow", "long"), "28 ноября – 3 декабря");
    assert.equal(formatTaskPeriod(undefined, "2026-05-13", "Europe/Moscow", "long"), "до 13 мая");
    assert.equal(formatTaskPeriod("2026-11-12", "2026-11-13"), "12–13 нояб");
  });

  it("этап по событию: неизвестное событие и служебные имена получают общий вид", () => {
    assert.equal(taskStageLook("task_overdue").light, "#bf3434");
    assert.equal(taskStageLook("stock_reservation_ready").event, "Изменения по задаче");
    assert.equal(taskStageLook("toString").event, "Изменения по задаче");
    assert.equal(taskStageLook("__proto__").event, "Изменения по задаче");
  });
});
