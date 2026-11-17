import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuoteNumber, quoteActions, quoteItemProblem, quoteOverdue, quoteWorkbookSheet } from "./quotes.js";

describe("КП", () => {
  it("переходы статусов как в страже базы: принятое — окончательно", () => {
    assert.deepEqual(quoteActions("draft").map((item) => item.to), ["sent", "rejected"]);
    assert.deepEqual(quoteActions("sent").map((item) => item.to), ["accepted", "rejected", "expired", "draft"]);
    assert.deepEqual(quoteActions("rejected").map((item) => item.to), ["draft"]);
    assert.deepEqual(quoteActions("expired").map((item) => item.to), ["draft"]);
    assert.deepEqual(quoteActions("accepted"), []);
    assert.equal(quoteActions("draft")[0]?.primary, true);
  });

  it("отправленное КП с прошедшим сроком подсвечивается", () => {
    assert.equal(quoteOverdue({ status: "sent", validUntil: "2026-11-10" }, "2026-11-17"), true);
    assert.equal(quoteOverdue({ status: "sent", validUntil: "2026-11-17" }, "2026-11-17"), false);
    assert.equal(quoteOverdue({ status: "draft", validUntil: "2026-11-10" }, "2026-11-17"), false);
    assert.equal(quoteOverdue({ status: "sent" }, "2026-11-17"), false);
  });

  it("позиция: количество больше нуля, штучная — целое, цена не меньше нуля", () => {
    assert.equal(quoteItemProblem({ quantity: 2, unitPrice: 100 }), undefined);
    assert.equal(quoteItemProblem({ quantity: 0, unitPrice: 100 }), "Количество должно быть больше нуля");
    assert.equal(quoteItemProblem({ quantity: 1.5, unitPrice: 1, countable: true, article: "A-1" }), "Запчасть «A-1» считается штуками: укажите целое количество");
    assert.equal(quoteItemProblem({ quantity: 1.5, unitPrice: 1, countable: false }), undefined);
    assert.equal(quoteItemProblem({ quantity: 1, unitPrice: -1 }), "Цена не может быть меньше нуля");
    assert.equal(parseQuoteNumber("1 500,50"), 1500.5);
    assert.ok(Number.isNaN(parseQuoteNumber("")));
  });

  it("выгрузка: шапка, позиции с номерами, итог", () => {
    const sheet = quoteWorkbookSheet(
      { number: "КП-000003", name: "Лампы для КДЛ", status: "sent", siteName: "КДЛ", payerName: "ГКБ", validUntil: "2026-12-01", totalAmount: 3100 },
      [{ description: "Лампа", code: "LAMP-1", quantity: 2, unitPrice: 1500, lineTotal: 3000 }, { description: "Доставка", quantity: 1, unitPrice: 100, lineTotal: 100 }]
    );
    assert.equal(sheet.name, "КП-000003");
    assert.deepEqual(sheet.rows[0], [{ bold: "Коммерческое предложение КП-000003" }]);
    assert.deepEqual(sheet.rows[2], ["Клиент", "КДЛ · ГКБ"]);
    assert.deepEqual(sheet.rows[3], ["Действует до", { date: "2026-12-01" }]);
    assert.deepEqual(sheet.rows[(sheet.headerRow ?? 0) - 1], ["№", "Наименование", "Артикул / вид работ", "Количество", "Цена, ₽", "Сумма, ₽"]);
    assert.deepEqual(sheet.rows[sheet.headerRow ?? 0], [1, "Лампа", "LAMP-1", 2, 1500, 3000]);
    assert.deepEqual(sheet.rows.at(-1), ["", { bold: "Итого" }, "", "", "", 3100]);
  });
});
