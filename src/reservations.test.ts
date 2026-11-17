import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient, stockReservationRecord } from "./m2-api.js";
import { EMPTY_RESERVATION_FILTERS, RESERVATION_BOARD_STATUSES, RESERVATION_STATUS_LABELS, availableReservationActions, filterReservations, hasReservationFilters, issueBlockReason, reservationActions, reservationDropDecision, reservationFilterOptions, reservationQuantityText, reservationStepAuthorText, reservationStepText, reservationSummary, reservationTaskNote, type ReservationFilters } from "./reservations.js";

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

  it("подпись последнего шага рядом с бейджем без названия состояния, а в списке всех шагов с ним", () => {
    const step = { status: "issued", changedAt: "2026-11-10T16:58:00Z", actorName: "Никитина Ольга Павловна" } as const;
    assert.equal(reservationStepAuthorText(step), "Никитина Ольга Павловна · 10.11.2026 19:58");
    assert.equal(reservationStepText(step), "У инженера · Никитина Ольга Павловна · 10.11.2026 19:58");
    // Без автора остаётся только время, лишних разделителей нет.
    assert.equal(reservationStepAuthorText({ status: "issued", changedAt: "2026-11-10T16:58:00Z" }), "10.11.2026 19:58");
  });

  it("колонки доски идут по ходу жизни резерва, снятого резерва на доске нет", () => {
    assert.deepEqual(RESERVATION_BOARD_STATUSES, ["created", "warehouse_notified", "issued", "installed", "returned"]);
  });

  it("переносом карточки делает ровно то, что кнопками, и объясняет отказ", () => {
    const ready = { status: "created", taskStatus: "in_progress", engineerName: "Иванов", taskNumber: "З-1" } as const;
    // Те же три действия, что у кнопок строки: собрать, выдать, принять обратно.
    assert.deepEqual(reservationDropDecision(ready, "warehouse_notified"), { kind: "move", action: "ready" });
    assert.deepEqual(reservationDropDecision({ ...ready, status: "warehouse_notified" }, "issued"), { kind: "move", action: "issue" });
    assert.deepEqual(reservationDropDecision({ ...ready, status: "issued" }, "returned"), { kind: "move", action: "return" });
    // Своя колонка: переносить нечего, молча.
    assert.deepEqual(reservationDropDecision(ready, "created"), { kind: "no", reason: "" });
    /** Причина отказа: на перенос, который разрешён, тест и не должен попадать. */
    const refusal = (reservation: Parameters<typeof reservationDropDecision>[0], to: Parameters<typeof reservationDropDecision>[1]) => {
      const decision = reservationDropDecision(reservation, to);
      assert.equal(decision.kind, "no");
      return decision.kind === "no" ? decision.reason : "";
    };
    // Установку отмечает инженер, назад резерв не возвращают, через состояние не прыгают.
    assert.match(refusal(ready, "installed"), /отмечает инженер/u);
    assert.match(refusal({ ...ready, status: "issued" }, "created"), /не возвращают/u);
    assert.match(refusal(ready, "issued"), /только в следующее состояние/u);
    // Нельзя выдать: причина та же, что в подсказке неактивной кнопки.
    assert.match(refusal({ status: "warehouse_notified", taskStatus: "in_progress", taskNumber: "З-1" }, "issued"), /не назначен инженер/u);
    assert.match(refusal({ status: "created", taskStatus: "cancelled", engineerName: "Иванов", taskNumber: "З-1" }, "warehouse_notified"), /Задача отменена.*снимите резерв/u);
  });

  it("отбирает резервы по состоянию, инженеру, задаче, запчасти и словам поиска", () => {
    const base = {
      id: "r1", number: "Р-000001", status: "created", partId: "p1", articleNumber: "AU-LAMP", partName: "Лампа галогеновая",
      condition: "N", quantity: 1, installMarked: false, steps: [], createdAt: "2026-11-10T07:00:00Z", updatedAt: "2026-11-10T07:00:00Z"
    } as const;
    const items = [
      { ...base, taskNumber: "З-1", taskTitle: "Ремонт дозатора", engineerName: "Иванов Пётр Алексеевич" },
      { ...base, id: "r2", number: "Р-000002", status: "issued", partId: "p2", articleNumber: "XN-FILTER", partName: "Фильтр крови", aliases: ["12V20W-AU"], taskNumber: "З-2", engineerName: "Иванов Пётр Алексеевич", issuedToName: "Кузнецова Мария Олеговна" },
      { ...base, id: "r3", number: "Р-000003", status: "issued", taskNumber: "З-2", engineerName: "Иванов Пётр Алексеевич" }
    ] as const;
    const pick = (filters: Partial<ReservationFilters>) => filterReservations(items, { ...EMPTY_RESERVATION_FILTERS, ...filters }).map((item) => item.id);
    assert.deepEqual(pick({}), ["r1", "r2", "r3"]);
    assert.deepEqual(pick({ status: "issued" }), ["r2", "r3"]);
    // Инженер строки — тот, кому выдали, а не инженер задачи.
    assert.deepEqual(pick({ engineer: "Кузнецова Мария Олеговна" }), ["r2"]);
    assert.deepEqual(pick({ engineer: "Иванов Пётр Алексеевич" }), ["r1", "r3"]);
    assert.deepEqual(pick({ taskNumber: "З-2" }), ["r2", "r3"]);
    assert.deepEqual(pick({ partId: "p1" }), ["r1", "r3"]);
    assert.deepEqual(pick({ search: "фильтр" }), ["r2"]);
    assert.deepEqual(pick({ search: "лампа З-2" }), ["r3"]);
    assert.deepEqual(pick({ search: "  " }), ["r1", "r2", "r3"]);
    // Псевдонимы артикулов (0047): запчасть находится по артикулу любого поставщика,
    // и так же, как на складе, — без пробелов и дефисов.
    assert.deepEqual(pick({ search: "12V20W-AU" }), ["r2"]);
    assert.deepEqual(pick({ search: "12v20wau" }), ["r2"]);
    assert.deepEqual(pick({ search: "aulamp" }), ["r1", "r3"]);
    // Условия складываются: ничего не подходит — пустой список.
    assert.deepEqual(pick({ status: "created", engineer: "Кузнецова Мария Олеговна" }), []);

    const options = reservationFilterOptions(items);
    // В списках только то, что есть в загруженных резервах, состояния по ходу жизни резерва.
    assert.deepEqual(options.statuses, [{ value: "created", label: "Ждёт сборки" }, { value: "issued", label: "У инженера" }]);
    assert.deepEqual(options.engineers.map((item) => item.value), ["Иванов Пётр Алексеевич", "Кузнецова Мария Олеговна"]);
    assert.deepEqual(options.tasks.map((item) => item.label), ["З-1 · Ремонт дозатора", "З-2"]);
    // У одной задачи резервы пришли и с названием, и без: в списке остаётся подпись подробнее.
    assert.deepEqual(reservationFilterOptions([...items, { ...items[1]!, id: "r4", taskTitle: "Замена фильтра" }]).tasks.map((item) => item.label),
      ["З-1 · Ремонт дозатора", "З-2 · Замена фильтра"]);
    assert.equal(hasReservationFilters(EMPTY_RESERVATION_FILTERS), false);
    assert.equal(hasReservationFilters({ ...EMPTY_RESERVATION_FILTERS, search: "  " }), false);
    assert.equal(hasReservationFilters({ ...EMPTY_RESERVATION_FILTERS, status: "issued" }), true);
    assert.deepEqual(options.parts.map((item) => item.label), ["AU-LAMP · Лампа галогеновая", "XN-FILTER · Фильтр крови"]);
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
    const part = fakeClient({});
    await new M2ApiClient(part.client).returnStockReservation("r1", 1);
    assert.deepEqual(part.calls, [["rpc", "return_stock_reservation", { p_reservation_id: "r1", p_quantity: 1 }]], "возврат части передаёт количество (0066)");
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
