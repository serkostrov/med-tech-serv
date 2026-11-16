import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invoiceExportColumns, invoiceSheets, invoiceWorkbook, type InvoiceExportRow } from "./invoice-export.js";
import { buildXlsx } from "./xlsx.js";

const ROWS: readonly InvoiceExportRow[] = [
  {
    "Номер счёта": "СЧ-000042",
    Дата: "2026-11-05",
    Плательщик: "ООО «Медицинский центр Здоровье»",
    ИНН: "7701234567",
    КПП: "770101001",
    Задача: "З-000123",
    "Вид работы или артикул": "Плановое ТО",
    Количество: 1,
    Цена: 12000,
    Сумма: 12000,
    Гарантия: ""
  },
  {
    "Номер счёта": "СЧ-000042",
    Дата: "2026-11-05",
    Плательщик: "ООО «Медицинский центр Здоровье»",
    ИНН: "7701234567",
    КПП: "770101001",
    Задача: "З-000123",
    "Вид работы или артикул": "AU-LAMP",
    Количество: 2,
    Цена: 1500,
    Сумма: 3000,
    Гарантия: "Да"
  }
];

describe("выгрузка счёта файлом", () => {
  it("берёт столбцы у базы и не придумывает своих", () => {
    assert.deepEqual(invoiceExportColumns(ROWS).slice(0, 3), ["Номер счёта", "Дата", "Плательщик"]);
    // Столбец, который появился только во второй строке, встаёт в конец.
    assert.deepEqual(invoiceExportColumns([{ a: 1 }, { a: 2, b: 3 }]), ["a", "b"]);
    assert.deepEqual(invoiceExportColumns([]), []);
  });

  it("кладёт счёт на один лист: шапка сверху, по строке на позицию", () => {
    const [sheet] = invoiceSheets(ROWS);
    assert.equal(sheet?.name, "Счёт");
    assert.equal(sheet?.headerRow, 1);
    assert.equal(sheet?.rows.length, 3);
    assert.deepEqual(sheet?.rows[0]?.slice(0, 2), ["Номер счёта", "Дата"]);
    // Числа остаются числами, дата — настоящей датой Excel.
    assert.equal(sheet?.rows[1]?.[8], 12000);
    assert.deepEqual(sheet?.rows[1]?.[1], { date: "2026-11-05" });
    assert.equal(sheet?.rows[2]?.[10], "Да");
    assert.equal(sheet?.widths?.length, invoiceExportColumns(ROWS).length);
  });

  it("пустую клетку оставляет пустой, а момент времени отдаёт с часами", () => {
    const [sheet] = invoiceSheets([{ Дата: "2026-11-05T09:30:00.000Z", Примечание: "" }]);
    assert.deepEqual(sheet?.rows[1], [{ date: "2026-11-05T09:30:00.000Z", withTime: true }, ""]);
  });

  it("не падает на счёте без позиций", () => {
    const [sheet] = invoiceSheets([]);
    assert.equal(sheet?.rows.length, 1);
    assert.deepEqual(sheet?.rows[0], ["В счёте нет позиций"]);
  });

  it("собирает файл .xlsx, который открывается как zip-архив", async () => {
    const file = await invoiceWorkbook(ROWS);
    // PK — подпись zip: именно так устроен .xlsx.
    assert.deepEqual([...file.slice(0, 2)], [0x50, 0x4b]);
    assert.ok(file.byteLength > 0);
    assert.ok(buildXlsx(invoiceSheets(ROWS)).byteLength > 0);
  });
});
