import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelDeliveryCommand, OutboxSqlExecutor } from "./outbox.js";
import { PostgresEmailTaskCardSource } from "./smtp.js";
import {
  cardNumber, cardRows, cardTitle, formatTaskPeriod, loadTaskCardFromPlan,
  taskCardFromVariables, taskStageLook, type TaskCardData
} from "./task-card.js";
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

/** Резерв из примера ТЗ: клапан 115-107131-00, 1 шт., новая, задача З-000041. */
const stock: TaskCardData = {
  eventCode: "stock_reservation_created",
  recipientName: "Кладовщик один",
  reservationNumber: "Р-000012",
  partArticle: "115-107131-00",
  partName: "клапан",
  quantity: "1",
  condition: "новая",
  taskNumber: "З-000041",
  taskTitle: "Ремонт BS-620",
  siteName: "ГКБ № 1",
  engineerName: "Иванов П. А."
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
    assert.equal(taskStageLook("equipment_moved").event, "Изменения по задаче");
    assert.equal(taskStageLook("toString").event, "Изменения по задаче");
    assert.equal(taskStageLook("__proto__").event, "Изменения по задаче");
  });

  it("события резерва: свой вид и свой заголовок, номер карточки — номер резерва", () => {
    assert.equal(taskStageLook("stock_reservation_created").event, "Новый резерв запчастей");
    assert.equal(taskStageLook("stock_reservation_ready").event, "Запчасти можно забрать");
    assert.equal(cardTitle({ ...stock, eventCode: "stock_reservation_ready" }, 120), "клапан");
    assert.equal(cardNumber({ ...stock, eventCode: "stock_reservation_ready" }, 24), "Р-000012");
    // У задачи заголовок и номер прежние.
    assert.equal(cardTitle({ eventCode: "task_overdue", taskTitle: "Замена датчика давления" }, 120), "Замена датчика давления");
    assert.equal(cardNumber({ eventCode: "task_overdue", taskNumber: "З-000007" }, 24), "З-000007");
    // Без данных карточка всё равно рисуется.
    assert.equal(cardTitle({ eventCode: "stock_reservation_created" }, 120), "Запчасть");
    assert.equal(cardTitle({ eventCode: "task_overdue" }, 120), "Без названия");
  });

  it("строки карточки резерва: что собрать, сколько и для какой задачи", () => {
    const limits = { site: 100, person: 60, part: 80, task: 120 };
    const created = cardRows({ ...stock, eventCode: "stock_reservation_created" }, limits, undefined);
    assert.deepEqual(created.map((row) => [row.label, row.value]), [
      ["Артикул", "115-107131-00"],
      ["Количество", "1 шт., новая"],
      ["Задача", "З-000041 «Ремонт BS-620»"],
      ["Площадка", "ГКБ № 1"],
      ["Инженер", "Иванов П. А."]
    ]);
    // Инженеру, который сам пришёл за запчастью, строка про него самого не нужна.
    const ready = cardRows({ ...stock, eventCode: "stock_reservation_ready" }, limits, undefined);
    assert.deepEqual(ready.map((row) => row.label), ["Артикул", "Количество", "Задача", "Площадка"]);
    // Карточка задачи не изменилась: площадка, инженер, срок.
    const task = cardRows({ eventCode: "task_engineer_assigned", siteName: "ГКБ №1", engineerName: "не назначен" }, limits, "12 нояб");
    assert.deepEqual(task.map((row) => [row.label, row.value, row.dim]), [
      ["Площадка", "ГКБ №1", false],
      ["Инженер", "не назначен", true],
      ["Срок", "12 нояб", false]
    ]);
  });

  it("переменные резерва попадают в карточку из плана рассылки", () => {
    const card = taskCardFromVariables("stock_reservation_created", {
      recipientName: "Кладовщик один",
      reservationNumber: "Р-000012",
      partArticle: "115-107131-00",
      partName: "клапан",
      quantity: "1",
      condition: "новая",
      taskNumber: "З-000041",
      taskTitle: "Ремонт BS-620",
      siteName: "ГКБ № 1",
      engineerName: "Иванов П. А."
    });
    assert.equal(card?.reservationNumber, "Р-000012");
    assert.equal(card?.partArticle, "115-107131-00");
    assert.equal(card?.partName, "клапан");
    assert.equal(card?.quantity, "1");
    assert.equal(card?.condition, "новая");
  });
});
