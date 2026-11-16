import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PostgrestClient } from "@supabase/postgrest-js";
import { M2ApiClient } from "./m2-api.js";

type FakeResponse = { readonly data?: unknown; readonly error?: { readonly message: string } | null; readonly count?: number | null };

/** Тот же приём, что в registry-search.test.ts: запоминаем, что ушло в базу. */
function fakeSupabase(routes: Readonly<Record<string, FakeResponse>>) {
  const requests: { readonly target: string; readonly calls: unknown[][] }[] = [];
  const builder = (target: string, first: unknown[]) => {
    const calls: unknown[][] = [first];
    requests.push({ target, calls });
    const result = Promise.resolve({ data: null, error: null, count: null, ...(routes[target] ?? {}) });
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "insert", "update", "delete", "eq", "in", "ilike", "order", "range", "limit", "maybeSingle", "single"]) {
      chain[method] = (...args: unknown[]) => { calls.push([method, ...args]); return chain; };
    }
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result.then(resolve, reject);
    return chain;
  };
  const client = {
    from: (table: string) => builder(table, ["from", table]),
    rpc: (fn: string, args?: unknown, options?: unknown) => builder(`rpc:${fn}`, ["rpc", fn, args, options])
  };
  const of = (target: string) => requests.filter((request) => request.target === target).map((request) => request.calls);
  const step = (calls: readonly unknown[][] | undefined, method: string) => (calls ?? []).filter((call) => call[0] === method).map((call) => call.slice(1));
  return { client: client as never, requests, of, step };
}

const MOVEMENT_ROW = {
  id: "m1", movement_type: "writeoff", part_condition: "G", quantity: "1.000", on_hand_delta: "-1.000",
  on_hand_after: "3.000", occurred_at: "2026-11-06T16:20:00+03:00", comment: "Бой при перевозке",
  performed_by_name: "Никитина Ольга Павловна", task_id: null, task_number: null, reservation_number: null,
  equipment_serial_number: null, lot_code: null, total_count: "7"
};

describe("склад: история движений, списание и корректировка", () => {
  it("история читается функцией базы страницами, общее число берётся из строки", async () => {
    const fake = fakeSupabase({ "rpc:inventory_part_movements": { data: [MOVEMENT_ROW] } });
    const page = await new M2ApiClient(fake.client).inventoryPartMovements("p1", 50, 100);
    assert.deepEqual(fake.of("rpc:inventory_part_movements")[0]?.[0], [
      "rpc", "inventory_part_movements", { p_part_id: "p1", p_limit: 50, p_offset: 100 }, { get: true }
    ]);
    assert.equal(page.total, 7);
    assert.deepEqual(page.items[0], {
      id: "m1", type: "writeoff", condition: "G", quantity: 1, delta: -1, onHandAfter: 3,
      occurredAt: "2026-11-06T16:20:00+03:00", comment: "Бой при перевозке", actorName: "Никитина Ольга Павловна"
    });
  });

  it("пустая история не выдумывает общее число", async () => {
    const fake = fakeSupabase({ "rpc:inventory_part_movements": { data: [] } });
    assert.deepEqual(await new M2ApiClient(fake.client).inventoryPartMovements("p1"), { items: [], total: 0 });
  });

  it("списание и корректировка уходят в функции базы с причиной и возвращают остаток", async () => {
    const fake = fakeSupabase({ "rpc:write_off_stock": { data: 8 }, "rpc:adjust_stock": { data: 6 } });
    const api = new M2ApiClient(fake.client);
    assert.equal(await api.writeOffInventoryPart({ partId: "p1", condition: "N", quantity: 2, reason: "Бой при перевозке" }), 8);
    assert.deepEqual(fake.of("rpc:write_off_stock")[0]?.[0], [
      "rpc", "write_off_stock", { p_part_id: "p1", p_condition: "N", p_quantity: 2, p_reason: "Бой при перевозке" }, undefined
    ]);
    assert.equal(await api.adjustInventoryPart({ partId: "p1", condition: "N", countedQuantity: 6, reason: "Инвентаризация 11/2026" }), 6);
    assert.deepEqual(fake.of("rpc:adjust_stock")[0]?.[0], [
      "rpc", "adjust_stock", { p_part_id: "p1", p_condition: "N", p_counted_quantity: 6, p_reason: "Инвентаризация 11/2026" }, undefined
    ]);
  });

  it("разбор накладной только читает, приход идёт отдельным вызовом", async () => {
    const fake = fakeSupabase({
      "rpc:preview_stock_receipt": { data: [{ row_no: 2, article: "12V20W-AU", part_id: "p1", part_article: "AU-LAMP-12V20W", part_name: "Лампа", matched_by: "alias", part_condition: "N", quantity: "4.000", unit_price: "1500.50" }] },
      "rpc:receive_stock_batch": { data: [{ part_id: "p1", part_article: "AU-LAMP-12V20W", part_name: "Лампа", part_condition: "N", quantity: "4.000", on_hand_after: "7.000" }] }
    });
    const api = new M2ApiClient(fake.client);
    const rows = [{ row: 2, article: "12V20W-AU", quantity: "4", condition: "Н" }];
    const preview = await api.previewStockReceipt(rows);
    // Предпросмотр ничего не меняет на складе: функция базы объявлена STABLE.
    assert.deepEqual(fake.of("rpc:preview_stock_receipt")[0]?.[0], ["rpc", "preview_stock_receipt", { p_items: rows }, undefined]);
    assert.deepEqual(preview[0], {
      rowNo: 2, article: "12V20W-AU", partId: "p1", partArticle: "AU-LAMP-12V20W", partName: "Лампа",
      matchedBy: "alias", condition: "N", quantity: 4, unitPrice: 1500.5
    });
    const applied = await api.receiveStockBatch(rows);
    assert.deepEqual(fake.of("rpc:receive_stock_batch")[0]?.[0], ["rpc", "receive_stock_batch", { p_items: rows }, undefined]);
    assert.deepEqual(applied[0], {
      partId: "p1", partArticle: "AU-LAMP-12V20W", partName: "Лампа", condition: "N", quantity: 4, onHandAfter: 7
    });
  });

  it("псевдонимы артикула читаются, добавляются и убираются", async () => {
    const fake = fakeSupabase({ part_aliases: { data: [{ id: "a1", alias: "12V20W-AU", created_at: "2026-02-11T08:00:00+03:00" }] } });
    const api = new M2ApiClient(fake.client);
    assert.deepEqual(await api.partAliases("p1"), [{ id: "a1", alias: "12V20W-AU", createdAt: "2026-02-11T08:00:00+03:00" }]);
    await api.addPartAlias("p1", "  LMP 480/680 ");
    assert.deepEqual(fake.step(fake.of("part_aliases")[1], "insert"), [[{ part_id: "p1", alias: "LMP 480/680" }]]);
    await api.removePartAlias("a1");
    assert.deepEqual(fake.step(fake.of("part_aliases")[2], "eq"), [["id", "a1"]]);
    await assert.rejects(() => api.addPartAlias("p1", "   "), /артикул поставщика/u);
  });

  it("строки накладной доезжают до базы целиком, а не строкой «[object Object]»", async () => {
    // Через настоящий postgrest-js: с { get: true } массив объектов складывается в адрес
    // как «{[object Object],…}» — накладная теряется по дороге, и разбор не работает вовсе.
    const sent: { method?: string; url: string; body?: unknown }[] = [];
    const fetchStub = async (url: string | URL, options?: { method?: string; body?: unknown }) => {
      sent.push({ url: String(url), ...(options?.method ? { method: options.method } : {}), body: options?.body });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new PostgrestClient("http://test.local", { fetch: fetchStub as never });
    const api = new M2ApiClient({ rpc: client.rpc.bind(client) } as never);
    const rows = [{ row: 2, article: "12V20W-AU", quantity: "4", condition: "Н" }];
    await api.previewStockReceipt(rows);
    await api.receiveStockBatch(rows);
    for (const request of sent) {
      assert.equal(request.method, "POST", "строки накладной уходят телом запроса");
      assert.doesNotMatch(String(request.url), /object Object/u);
      assert.deepEqual(JSON.parse(String(request.body)), { p_items: rows });
    }
    // История читается адресной строкой: там только простые значения, им это не вредит.
    sent.length = 0;
    await api.inventoryPartMovements("p1", 10, 0);
    assert.match(String(sent[0]?.url), /p_part_id=p1&p_limit=10&p_offset=0/u);
  });

  it("приход файлом ничего не меняет до подтверждения человеком", async () => {
    const source = await readFile(new URL("./StockReceiptImport.tsx", import.meta.url), "utf8");
    // Выбор файла только спрашивает базу, что распознано; приход — отдельной кнопкой.
    const choose = source.slice(source.indexOf("const chooseFile"), source.indexOf("const changeComment"));
    assert.match(choose, /previewStockReceipt|askDatabase/u);
    assert.doesNotMatch(choose, /receiveStockBatch/u);
    const apply = source.slice(source.indexOf("const apply = async"), source.indexOf("return <Dialog"));
    assert.match(apply, /receiveStockBatch/u);
    // Кнопка прихода неактивна, пока в разборе есть хоть одна ошибка.
    assert.match(source, /summary\.broken === 0/u);
    assert.match(source, /disabled=\{!ready\}/u);
  });

  it("окно склада открывает карточку позиции и приход накладной", async () => {
    const source = await readFile(new URL("./OperationsPages.tsx", import.meta.url), "utf8");
    assert.match(source, /<InventoryPartCard/u);
    assert.match(source, /<StockReceiptImport/u);
    // Остаток по состояниям стоит в списке и подсказкой словами.
    assert.match(source, /conditionTotalsText\(part\.onHandByCondition\)/u);
    assert.match(source, /title=\{conditionTotalsTitle\(part\.onHandByCondition\)\}/u);
    // Складские операции предлагаются только роли склада; решает всё равно база.
    assert.match(source, /hasPermission\("warehouse\.write"\)/u);
  });
});
