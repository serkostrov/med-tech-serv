import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  stockDocumentBasis,
  stockDocumentEquipment,
  stockDocumentFileName,
  stockDocumentSheets,
  stockDocumentTotalsText,
  type StockDocumentLine,
  type StockDocumentRecord
} from "./stock-documents.js";

const transfer: StockDocumentRecord = {
  id: "d1", number: "ПМ-000041", kind: "transfer", date: "2026-11-17",
  taskId: "t1", taskNumber: "З-001241", taskTitle: "Ошибка дозатора",
  equipmentSerialNumber: "XN-1000-004512", equipmentName: "Sysmex XN-1000",
  siteName: "ГКБ № 1, КДЛ", engineerName: "Иванов Пётр", lineCount: 2, totalQuantity: 3
};

const writeoff: StockDocumentRecord = {
  id: "d2", number: "СП-000028", kind: "writeoff", date: "2026-11-06", lineCount: 1, totalQuantity: 1
};

const lines: readonly StockDocumentLine[] = [
  { documentId: "d1", movementId: "m1", articleNumber: "XN-FLT", partName: "Фильтр", condition: "N", quantity: 2, reservationNumber: "Р-000131", occurredAt: "2026-11-17T09:00:00Z" },
  { documentId: "d1", movementId: "m2", articleNumber: "XN-PUMP", partName: "Насос", condition: "B", quantity: 1, reservationNumber: "Р-000132", occurredAt: "2026-11-17T09:05:00Z" },
  { documentId: "d2", movementId: "m3", articleNumber: "AU-LAMP", partName: "Лампа", condition: "G", quantity: 1, occurredAt: "2026-11-06T13:20:00Z", comment: "Бой при перевозке" }
];

describe("документы склада", () => {
  it("основание — задача, а у списания брака — причина", () => {
    assert.equal(stockDocumentBasis(transfer), "Задача З-001241 · Ошибка дозатора");
    assert.equal(stockDocumentBasis(writeoff, lines.filter((line) => line.documentId === "d2")), "Списание со склада: Бой при перевозке");
    assert.equal(stockDocumentBasis(writeoff), "Списание со склада");
  });

  it("прибор и итоги подписаны по-человечески", () => {
    assert.equal(stockDocumentEquipment(transfer), "Sysmex XN-1000 · S/N XN-1000-004512");
    assert.equal(stockDocumentEquipment(writeoff), "");
    assert.equal(stockDocumentTotalsText(transfer), "2 строки · 3 шт.");
    assert.equal(stockDocumentTotalsText({ lineCount: 1, totalQuantity: 1.5 }), "1 строка · 1,5 шт.");
    assert.equal(stockDocumentTotalsText({ lineCount: 11, totalQuantity: 11 }), "11 строк · 11 шт.");
  });

  it("в Excel строка на каждую запчасть, шапка документа повторяется", () => {
    const [sheet] = stockDocumentSheets([transfer, writeoff], lines);
    assert.ok(sheet);
    assert.equal(sheet.name, "Документы склада");
    assert.equal(sheet.rows.length, 4);
    assert.deepEqual(sheet.rows[1], [
      "ПМ-000041", "Перемещение на склад инженера", "17.11.2026", "Задача З-001241 · Ошибка дозатора",
      "Sysmex XN-1000 · S/N XN-1000-004512", "ГКБ № 1, КДЛ", "Иванов Пётр",
      "XN-FLT", "Фильтр", "Н · новая", 2, "Р-000131", ""
    ]);
    assert.equal(sheet.rows[2]?.[0], "ПМ-000041");
    assert.deepEqual(sheet.rows[3]?.slice(0, 4), ["СП-000028", "Списание", "06.11.2026", "Списание со склада: Бой при перевозке"]);
    assert.equal(sheet.rows[3]?.[12], "Бой при перевозке");
  });

  it("документ без строк всё равно попадает в файл", () => {
    const [sheet] = stockDocumentSheets([writeoff], []);
    assert.equal(sheet?.rows.length, 2);
    assert.equal(sheet?.rows[1]?.[0], "СП-000028");
  });

  it("имя файла одного документа", () => {
    assert.equal(stockDocumentFileName(transfer), "ПМ-000041 Перемещение 17.11.2026.xlsx");
  });
});
