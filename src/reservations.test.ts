import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient, stockReservationRecord } from "./m2-api.js";
import { RESERVATION_STATUS_LABELS, availableReservationActions, issueBlockReason, reservationActions, reservationQuantityText, reservationSummary, reservationTaskNote } from "./reservations.js";

/** Поддельный клиент Supabase: запоминает цепочку запроса к таблице и вызовы функций базы. */
function fakeClient(response: { data?: unknown; error?: { message: string; code?: string } | null }) {
  const calls: unknown[][] = [];
  const result = Promise.resolve({ data: null, error: null, ...response });
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "update", "eq", "in", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
  }
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result.then(resolve, reject);
  const client = {
    from: (table: string) => { calls.push(["from", table]); return chain; },
    rpc: (fn: string, args: unknown) => { calls.push(["rpc", fn, args]); return result; }
  };
  return { client: client as never, calls };
}

describe("резервы склада", () => {
  it("даёт складу только допустимые шаги: собрать, выдать, вернуть, отменить до выдачи", () => {
    assert.deepEqual(reservationActions("created"), ["ready", "cancel"]);
    assert.deepEqual(reservationActions("warehouse_notified"), ["issue", "cancel"]);
    assert.deepEqual(reservationActions("issued"), ["return"]);
    assert.deepEqual(reservationActions("installed"), []);
    assert.deepEqual(reservationActions("returned"), []);
    assert.deepEqual(reservationActions("cancelled"), []);
  });

  it("пишет количество со состоянием и считает, что собрать, выдать и что у инженеров", () => {
    assert.equal(reservationQuantityText({ quantity: 2, condition: "N" }), "2 шт. · новая");
    assert.equal(reservationQuantityText({ quantity: 1.5, condition: "B" }), "1,5 · б/у");
    assert.deepEqual(reservationSummary([
      { status: "created", taskStatus: "in_progress", engineerName: "Иванов" },
      { status: "created", taskStatus: "assigned" },
      { status: "created", taskStatus: "cancelled", engineerName: "Иванов" },
      { status: "warehouse_notified", taskStatus: "in_progress", engineerName: "Иванов" },
      { status: "warehouse_notified", taskStatus: "in_progress" },
      { status: "warehouse_notified", taskStatus: "cancelled", engineerName: "Иванов" },
      { status: "warehouse_notified", taskStatus: "closed", engineerName: "Иванов" },
      { status: "issued", taskStatus: "cancelled", engineerName: "Иванов" }
    ]), { toCollect: 2, ready: 1, withEngineers: 1 });
  });

  it("подписи состояний про запчасть, а не команды", () => {
    assert.equal(RESERVATION_STATUS_LABELS.created, "Ждёт сборки");
    assert.equal(RESERVATION_STATUS_LABELS.cancelled, "Резерв снят");
  });

  it("не даёт выдать по отменённой или закрытой задаче и без инженера, объясняет почему", () => {
    assert.match(issueBlockReason({ taskStatus: "cancelled", engineerName: "Иванов", taskNumber: "З-1" }) ?? "", /отменена.*снимите резерв/u);
    assert.match(issueBlockReason({ taskStatus: "closed", engineerName: "Иванов", taskNumber: "З-1" }) ?? "", /закрыта/u);
    assert.match(issueBlockReason({ taskStatus: "in_progress", taskNumber: "З-1" }) ?? "", /не назначен инженер/u);
    assert.equal(issueBlockReason({ taskStatus: "in_progress", engineerName: "Иванов", taskNumber: "З-1" }), undefined);
    assert.equal(reservationTaskNote({ taskStatus: "cancelled" }), "Задача отменена");
    assert.deepEqual(availableReservationActions({ status: "warehouse_notified", taskStatus: "cancelled" }), ["cancel"]);
    assert.deepEqual(availableReservationActions({ status: "created", taskStatus: "closed" }), ["cancel"]);
    assert.deepEqual(availableReservationActions({ status: "issued", taskStatus: "cancelled" }), ["return"]);
    assert.deepEqual(availableReservationActions({ status: "created", taskStatus: "in_progress" }), ["ready", "cancel"]);
    assert.equal(reservationTaskNote({ taskStatus: "assigned" }), undefined);
  });

  it("разбирает строку резерва с запчастью, задачей и инженером", () => {
    const record = stockReservationRecord({
      id: "r1", number: "Р-000001", status: "issued", part_id: "p1", part_condition: "G", quantity: "3.000", task_id: "t1",
      created_at: "2026-11-12T08:00:00Z", updated_at: "2026-11-12T09:00:00Z",
      part: { article_number: "AU-LAMP", name: "Лампа" },
      task: { number: "З-000123", title: "Замена лампы", status_code: "in_progress", engineer: { full_name: "Иванов Иван" } },
      issued: { full_name: "Иванов Иван" }
    });
    assert.equal(record.status, "issued");
    assert.equal(record.condition, "G");
    assert.equal(record.quantity, 3);
    assert.equal(record.articleNumber, "AU-LAMP");
    assert.equal(record.taskNumber, "З-000123");
    assert.equal(record.taskStatus, "in_progress");
    assert.equal(record.engineerName, "Иванов Иван");
    assert.equal(record.issuedToName, "Иванов Иван");
  });

  it("закрытый резерв без видимой задачи показывает без номера задачи", () => {
    const record = stockReservationRecord({ id: "r2", number: "Р-000002", status: "returned", part_id: "p1", part_condition: "N", quantity: 1, task_id: "t1", task: null, part: { article_number: "X", name: "Y" } });
    assert.equal(record.taskNumber, undefined);
    assert.equal(record.engineerName, undefined);
    assert.equal(record.taskId, "t1");
  });

  it("действующие резервы запрашивает по статусам в порядке заявки: строка не переезжает после действия", async () => {
    const { client, calls } = fakeClient({ data: [] });
    await new M2ApiClient(client).stockReservations("active");
    assert.deepEqual(calls[0], ["from", "stock_reservations"]);
    assert.deepEqual(calls.find((call) => call[0] === "in"), ["in", "status", ["created", "warehouse_notified", "issued"]]);
    assert.deepEqual(calls.filter((call) => call[0] === "order").map((call) => call[1]), ["created_at", "number"]);
    assert.match(String(calls.find((call) => call[0] === "select")?.[1]), /task:tasks\(number, title, status_code,/u);
  });

  it("выдачу и возврат проводит одной функцией базы", async () => {
    const issue = fakeClient({});
    await new M2ApiClient(issue.client).issueStockReservation("r1");
    assert.deepEqual(issue.calls, [["rpc", "issue_stock_reservation", { p_reservation_id: "r1" }]]);
    const back = fakeClient({});
    await new M2ApiClient(back.client).returnStockReservation("r1");
    assert.deepEqual(back.calls, [["rpc", "return_stock_reservation", { p_reservation_id: "r1" }]]);
  });

  it("пока базу не обновили, говорит об этом, а ошибку базы показывает как есть", async () => {
    const missing = fakeClient({ error: { message: "Could not find the function public.issue_stock_reservation", code: "PGRST202" } });
    await assert.rejects(new M2ApiClient(missing.client).issueStockReservation("r1"), /после обновления базы/u);
    const noEngineer = fakeClient({ error: { message: "В задаче не назначен инженер: выдавать некому" } });
    await assert.rejects(new M2ApiClient(noEngineer.client).issueStockReservation("r1"), /не назначен инженер/u);
  });

  it("отмена меняет только резерв, который ещё не выдан, иначе просит обновить список", async () => {
    const done = fakeClient({ data: [{ id: "r1" }] });
    await new M2ApiClient(done.client).cancelStockReservation("r1");
    assert.deepEqual(done.calls.find((call) => call[0] === "update"), ["update", { status: "cancelled" }]);
    assert.deepEqual(done.calls.find((call) => call[0] === "in"), ["in", "status", ["created", "warehouse_notified"]]);
    const stale = fakeClient({ data: [] });
    await assert.rejects(new M2ApiClient(stale.client).cancelStockReservation("r1"), /Обновите список/u);
  });
});
