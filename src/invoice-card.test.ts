import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  invoiceActions,
  invoiceAmounts,
  invoiceFileName,
  invoiceHistorySteps,
  invoiceItemGroups,
  invoiceLinesWithoutPrice,
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
      items: [line({ lineTotal: 1200.5 }), line({ lineTotal: 300.25 }), line({ excludedFromTotal: true, lineTotal: 5000 })],
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
