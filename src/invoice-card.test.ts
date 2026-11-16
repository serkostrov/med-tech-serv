import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { M2ApiClient } from "./m2-api.js";
import {
  invoiceActions,
  invoiceAmounts,
  invoiceFileName,
  invoiceHistorySteps,
  invoiceItemGroups,
  invoiceItemsInOrder,
  invoiceLineAmount,
  invoiceLinesWithoutPrice,
  invoicePreviewTotal,
  invoiceStatusLabel,
  invoiceStatusNote,
  invoiceStatusTone,
  parseInvoiceAdjustment,
  type InvoiceLine
} from "./invoice-card.js";

function line(input: Partial<InvoiceLine> = {}): InvoiceLine {
  return { itemType: "work", quantity: 1, unitPrice: 1000, lineTotal: 1000, modifier: "N", excludedFromTotal: false, ...input };
}

describe("карточка счёта", () => {
  it("делит строки на те, что идут в счёт, и гарантийные", () => {
    const guarantee = line({ modifier: "G", excludedFromTotal: true, lineTotal: 2500, unitPrice: 2500 });
    const part = line({ itemType: "part", quantity: 2, unitPrice: 300, lineTotal: 600 });
    const groups = invoiceItemGroups([line(), guarantee, part]);
    assert.equal(groups.billable.length, 2);
    assert.deepEqual(groups.guarantee, [guarantee]);
    // Порядок строк из базы не меняем.
    assert.equal(groups.billable[1], part);
  });

  it("считает итог: гарантийные строки видно, но в сумму они не идут", () => {
    const amounts = invoiceAmounts({
      items: [
        line({ lineTotal: 1200.5 }),
        line({ lineTotal: 300.25 }),
        // Гарантийной строке база сама ставит line_total = 0: справочную сумму считаем из цены.
        line({ modifier: "G", excludedFromTotal: true, quantity: 2, unitPrice: 2500, lineTotal: 0 })
      ],
      subtotal: 1500.75,
      adjustmentAmount: -500.75,
      totalAmount: 1000
    });
    assert.equal(amounts.billable, 1500.75);
    assert.equal(amounts.guarantee, 5000);
    assert.equal(amounts.subtotal, 1500.75);
    assert.equal(amounts.adjustment, -500.75);
    assert.equal(amounts.total, 1000);
    assert.equal(amounts.matches, true);
  });

  it("видит расхождение суммы строк с суммой счёта из базы", () => {
    const amounts = invoiceAmounts({ items: [line({ lineTotal: 1000 })], subtotal: 1500, adjustmentAmount: 0, totalAmount: 1500 });
    assert.equal(amounts.matches, false);
    // Показываем всё равно суммы базы: это она считает итог.
    assert.equal(amounts.subtotal, 1500);
  });

  it("копейки складывает без хвостов double", () => {
    const amounts = invoiceAmounts({
      items: [line({ lineTotal: 0.1 }), line({ lineTotal: 0.2 })],
      subtotal: 0.3,
      adjustmentAmount: 0,
      totalAmount: 0.3
    });
    assert.equal(amounts.billable, 0.3);
    assert.equal(amounts.matches, true);
  });

  it("пустой счёт даёт нулевые суммы", () => {
    const amounts = invoiceAmounts({ items: [], subtotal: 0, adjustmentAmount: 0, totalAmount: 0 });
    assert.deepEqual([amounts.billable, amounts.guarantee, amounts.total], [0, 0, 0]);
    assert.equal(amounts.matches, true);
  });

  it("находит строки, которым не нашлось цены", () => {
    const zero = line({ unitPrice: 0, lineTotal: 0 });
    assert.deepEqual(invoiceLinesWithoutPrice([line(), zero]), [zero]);
  });

  it("сумму гарантийной строки показывает справочно, обычную — как посчитала база", () => {
    assert.equal(invoiceLineAmount(line({ quantity: 3, unitPrice: 100, lineTotal: 300 })), 300);
    assert.equal(invoiceLineAmount(line({ excludedFromTotal: true, quantity: 3, unitPrice: 100.005, lineTotal: 0 })), 300.02);
  });

  it("строит позиции по задачам: работа перед запчастями, без задачи — в конце", () => {
    const items = [
      { id: "4", taskNumber: null, itemType: "work" as const },
      { id: "3", taskNumber: "З-000002", itemType: "part" as const },
      { id: "2", taskNumber: "З-000001", itemType: "part" as const },
      { id: "1", taskNumber: "З-000001", itemType: "work" as const },
      { id: "5", taskNumber: "З-000001", itemType: "part" as const }
    ];
    assert.deepEqual(invoiceItemsInOrder(items).map((item) => item.id), ["1", "2", "5", "3", "4"]);
  });

  it("показывает итог после корректировки так же, как его посчитает база", () => {
    assert.equal(invoicePreviewTotal(1500.5, -500.25), 1000.25);
    // Ниже нуля итог не уходит: в базе стоит greatest(0, …).
    assert.equal(invoicePreviewTotal(1000, -5000), 0);
  });

  it("показывает кнопки по статусу", () => {
    const kinds = (status: string, canWrite = true) => invoiceActions({ status, canWrite }).map((action) => action.kind);
    assert.deepEqual(kinds("draft"), ["issue", "rebuild", "correct", "cancel"]);
    assert.deepEqual(kinds("issued"), ["transfer", "correct", "cancel"]);
    // Передан в 1С и отменён: менять нечего.
    assert.deepEqual(kinds("transferred_to_1c"), []);
    assert.deepEqual(kinds("cancelled"), []);
    // Пересобрать по прайсу можно только черновик, скорректировать — пока счёт не в 1С.
    assert.ok(!kinds("issued").includes("rebuild"));
  });

  it("без права finance.write кнопок нет ни на одном статусе", () => {
    for (const status of ["draft", "issued", "transferred_to_1c", "cancelled"]) {
      assert.deepEqual(invoiceActions({ status, canWrite: false }), []);
    }
  });

  it("подписывает статус, его тон и говорит, что со счётом дальше", () => {
    assert.equal(invoiceStatusLabel("transferred_to_1c"), "Передан в 1С");
    // Новый статус из базы показываем кодом, а не пустотой.
    assert.equal(invoiceStatusLabel("paid"), "paid");
    assert.equal(invoiceStatusTone("draft"), "warning");
    assert.equal(invoiceStatusTone("transferred_to_1c"), "success");
    assert.match(invoiceStatusNote("draft"), /пересобрать по прайсу/u);
    assert.equal(invoiceStatusNote("paid"), "");
  });

  it("выстраивает историю статусов по времени", () => {
    const steps = invoiceHistorySteps([
      { status: "issued", at: "2026-11-06T09:00:00.000Z", actorName: "Морозова Елена Владимировна" },
      { status: "draft", at: "2026-11-05T08:00:00.000Z", actorName: null }
    ]);
    assert.deepEqual(steps.map((step) => step.label), ["Черновик", "Выставлен"]);
    assert.equal(steps[1]?.actorName, "Морозова Елена Владимировна");
  });

  it("читает сумму корректировки со знаком и отвергает бессмысленную", () => {
    assert.equal(parseInvoiceAdjustment("−1 500,50"), -1500.5);
    assert.equal(parseInvoiceAdjustment("-1500.50"), -1500.5);
    assert.equal(parseInvoiceAdjustment("2000"), 2000);
    assert.equal(parseInvoiceAdjustment("0"), null);
    assert.equal(parseInvoiceAdjustment(""), null);
    assert.equal(parseInvoiceAdjustment("минус тысяча"), null);
    assert.equal(parseInvoiceAdjustment("1000000000000000"), null);
  });

  it("называет файл выгрузки номером счёта", () => {
    assert.equal(invoiceFileName({ number: "СЧ-000042" }), "Счёт СЧ-000042.xlsx");
  });
});

type Answer = { data?: unknown; error?: { message: string; code?: string } | null };

/** Поддельный клиент Supabase: запоминает обращения к таблицам и функциям базы. */
function fakeClient(answer: (table: string, calls: unknown[][]) => Answer = () => ({})) {
  const log: { table: string; calls: unknown[][] }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, calls: [] as unknown[][] };
      log.push(entry);
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "update", "insert", "eq", "in", "order", "limit"]) {
        chain[method] = (...args: unknown[]) => { entry.calls.push([method, ...args]); return chain; };
      }
      chain.maybeSingle = (...args: unknown[]) => {
        entry.calls.push(["maybeSingle", ...args]);
        const result = { data: null, error: null, ...answer(table, entry.calls) };
        return Promise.resolve({ ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data });
      };
      chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null, ...answer(table, entry.calls) }).then(resolve, reject);
      return chain;
    },
    rpc: (fn: string, args: unknown) => {
      const entry = { table: `rpc:${fn}`, calls: [["rpc", fn, args]] };
      log.push(entry);
      return Promise.resolve({ data: null, error: null, ...answer(entry.table, entry.calls) });
    }
  };
  return { client: client as never, log };
}

const INVOICE_ROW = {
  id: "inv5", number: "СЧ-000042", status: "issued", payer_id: "p1", subtotal: "15000.00", adjustment_amount: "-500.00",
  total_amount: "14500.00", correction_reason: "Скидка по договору", issued_at: "2026-11-06T09:00:00.000Z", transferred_at: null,
  created_at: "2026-11-05T08:00:00.000Z", updated_at: "2026-11-06T09:00:00.000Z",
  payer: { id: "p1", name: "ООО «Здоровье»", requisites: { inn: "7701234567" } },
  invoice_tasks: [{ task_id: "t14" }]
};

const ITEM_ROWS = [
  {
    id: "ii1", item_type: "work", task_id: "t14", description: "Плановое ТО", quantity: "1", unit_price: "12000.00",
    line_total: "12000.00", modifier: "N", excluded_from_total: false, task: { number: "З-000123" }
  },
  {
    id: "ii2", item_type: "part", task_id: "t14", description: "Лампа галогеновая, Н", quantity: "2", unit_price: "1500.00",
    line_total: "3000.00", modifier: null, excluded_from_total: false, task: { number: "З-000123" }
  },
  {
    id: "ii3", item_type: "work", task_id: "t15", description: "Ремонт по гарантии", quantity: "1", unit_price: "8000.00",
    line_total: "0.00", modifier: "G", excluded_from_total: true, task: { number: "З-000124" }
  }
];

describe("счёт в API", () => {
  it("собирает карточку из счёта, позиций и истории статусов", async () => {
    const { client, log } = fakeClient((table) => {
      if (table === "invoices") return { data: [INVOICE_ROW] };
      if (table === "invoice_items") return { data: ITEM_ROWS };
      if (table === "invoice_status_history") {
        return { data: [
          { to_status: "draft", changed_at: "2026-11-05T08:00:00.000Z", changer: { full_name: "Морозова Елена Владимировна" } },
          { to_status: "issued", changed_at: "2026-11-06T09:00:00.000Z", changer: null }
        ] };
      }
      return {};
    });
    const card = await new M2ApiClient(client).invoiceCard("inv5");
    assert.equal(card.invoice.number, "СЧ-000042");
    assert.equal(card.invoice.issuedAt, "2026-11-06T09:00:00.000Z");
    assert.equal(card.invoice.transferredAt, undefined);
    assert.deepEqual(card.invoice.taskIds, ["t14"]);
    // Суммы приходят строками numeric: наружу отдаём числами.
    assert.deepEqual([card.subtotal, card.adjustmentAmount, card.totalAmount], [15000, -500, 14500]);
    assert.equal(card.correctionReason, "Скидка по договору");
    assert.deepEqual(card.items.map((item) => [item.itemType, item.quantity, item.unitPrice, item.excludedFromTotal]), [
      ["work", 1, 12000, false], ["part", 2, 1500, false], ["work", 1, 8000, true]
    ]);
    assert.equal(card.items[2]?.modifier, "G");
    assert.equal(card.items[0]?.taskNumber, "З-000123");
    assert.deepEqual(card.statusHistory.map((step) => [step.status, step.actorName]), [
      ["draft", "Морозова Елена Владимировна"], ["issued", null]
    ]);
    assert.deepEqual(log.find((entry) => entry.table === "invoice_items")?.calls.find((call) => call[0] === "eq"), ["eq", "invoice_id", "inv5"]);
  });

  it("счёт не найден — говорит об этом, а не показывает пустую карточку", async () => {
    const { client } = fakeClient(() => ({ data: [] }));
    await assert.rejects(new M2ApiClient(client).invoiceCard("inv404"), /Счёт не найден/u);
  });

  it("история без автора читается вторым запросом, карточка не падает", async () => {
    const { client, log } = fakeClient((table, calls) => {
      if (table === "invoices") return { data: [INVOICE_ROW] };
      if (table === "invoice_items") return { data: [] };
      if (table === "invoice_status_history") {
        const select = String(calls.find((call) => call[0] === "select")?.[1] ?? "");
        return select.includes("changer")
          ? { error: { message: "Could not find a relationship", code: "PGRST200" } }
          : { data: [{ to_status: "draft", changed_at: "2026-11-05T08:00:00.000Z" }] };
      }
      return {};
    });
    const card = await new M2ApiClient(client).invoiceCard("inv5");
    assert.deepEqual(card.statusHistory, [{ status: "draft", at: "2026-11-05T08:00:00.000Z", actorName: null }]);
    assert.equal(log.filter((entry) => entry.table === "invoice_status_history").length, 2);
  });

  it("переходы статусов зовут функции базы, а до миграции говорят по-человечески", async () => {
    const calls: Record<string, unknown> = {};
    const { client } = fakeClient((table, entries) => { calls[table] = entries[0]?.[2]; return {}; });
    const api = new M2ApiClient(client);
    await api.issueInvoice("inv5");
    await api.transferInvoiceTo1c("inv5");
    await api.correctInvoice("inv5", -500.5, "  Скидка по договору  ");
    await api.rebuildInvoiceItems("inv5");
    assert.deepEqual(calls["rpc:issue_invoice"], { p_invoice_id: "inv5" });
    assert.deepEqual(calls["rpc:transfer_invoice_to_1c"], { p_invoice_id: "inv5" });
    // Причину отправляем без лишних пробелов.
    assert.deepEqual(calls["rpc:correct_invoice"], { p_invoice_id: "inv5", p_adjustment: -500.5, p_reason: "Скидка по договору" });
    assert.deepEqual(calls["rpc:rebuild_invoice_items"], { p_invoice_id: "inv5" });

    const missing = (fn: string) => fakeClient(() => ({ error: { message: `Could not find the function public.${fn}`, code: "PGRST202" } })).client;
    await assert.rejects(new M2ApiClient(missing("issue_invoice")).issueInvoice("inv5"), /Выставление счёта заработает после обновления базы на сервере/u);
    await assert.rejects(new M2ApiClient(missing("transfer_invoice_to_1c")).transferInvoiceTo1c("inv5"), /Передача в 1С заработает после обновления базы/u);
    await assert.rejects(new M2ApiClient(missing("correct_invoice")).correctInvoice("inv5", -500, "Скидка"), /Корректировка счёта заработает после обновления базы/u);
    await assert.rejects(new M2ApiClient(missing("rebuild_invoice_items")).rebuildInvoiceItems("inv5"), /Пересборка позиций заработает после обновления базы/u);
  });

  it("корректировку без причины в базу не отправляет", async () => {
    const empty = fakeClient();
    await assert.rejects(new M2ApiClient(empty.client).correctInvoice("inv5", -500, "   "), /Напишите причину корректировки/u);
    await assert.rejects(new M2ApiClient(empty.client).correctInvoice("inv5", Number.NaN, "Скидка"), /сумму корректировки числом/u);
    assert.equal(empty.log.length, 0);
  });

  it("строки выгрузки отдаёт так, как их назвала база", async () => {
    const { client, log } = fakeClient(() => ({ data: [{ "Номер счёта": "СЧ-000042", Сумма: 12000, Гарантия: null }] }));
    const rows = await new M2ApiClient(client).invoiceExportRows("inv5");
    // Пустое значение становится пустой клеткой, а не словом «null».
    assert.deepEqual(rows, [{ "Номер счёта": "СЧ-000042", Сумма: 12000, Гарантия: "" }]);
    assert.deepEqual(log[0]?.calls[0], ["rpc", "invoice_export_rows", { p_invoice_id: "inv5" }]);
    const missing = fakeClient(() => ({ error: { message: "Could not find the function public.invoice_export_rows", code: "PGRST202" } }));
    await assert.rejects(new M2ApiClient(missing.client).invoiceExportRows("inv5"), /Выгрузка счёта заработает после обновления базы/u);
  });
});
