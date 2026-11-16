import assert from "node:assert/strict";
import test from "node:test";
import { buildXlsx, buildXlsxCompressed, zipStore } from "./xlsx.js";
import {
  columnIndex,
  excelSerialToDateText,
  isDateFormatCode,
  readXlsxWorkbook,
  XlsxReadError
} from "./xlsx-workbook.js";
import { CUSTOMER_SAMPLE_PATH, customerSampleWorkbook } from "./import-sample.test-helper.js";

test("номер столбца по ссылке ячейки", () => {
  assert.equal(columnIndex("A1"), 0);
  assert.equal(columnIndex("B7"), 1);
  assert.equal(columnIndex("Z10"), 25);
  assert.equal(columnIndex("AA3"), 26);
  assert.equal(columnIndex("3"), -1);
});

test("число Excel в календарную дату", () => {
  assert.equal(excelSerialToDateText(45376), "2024-03-25");
  assert.equal(excelSerialToDateText(45376.5), "2024-03-25T12:00:00");
  // До 1 марта 1900 нумерация Excel сбита «лишним» 29 февраля: такие числа не берём.
  assert.equal(excelSerialToDateText(1), undefined);
  assert.equal(excelSerialToDateText(-5), undefined);
  // Книга в системе 1904 года сдвинута на 1462 дня.
  assert.equal(excelSerialToDateText(43914, true), "2024-03-25");
});

test("дату узнаём по формату ячейки, а не по значению", () => {
  assert.equal(isDateFormatCode("dd.mm.yyyy"), true);
  assert.equal(isDateFormatCode("[$-419]d\\ mmmm\\ yyyy"), true);
  assert.equal(isDateFormatCode("#,##0.00"), false);
  assert.equal(isDateFormatCode("0.00\\ \"шт\""), false);
});

test("чтение книги, записанной нашим же генератором", async () => {
  const source = buildXlsx([{
    name: "Приборы",
    headerRow: 1,
    rows: [
      ["Серийный номер", "Модель", "Дата"],
      ["BE49081", "DxH-800", { date: "2024-03-25" }],
      ["be 49 082", "DxH 690T", { date: "2024-03-25T10:30:00Z", withTime: true }],
      [null, "", 42]
    ]
  }]);
  const book = await readXlsxWorkbook(source);
  assert.equal(book.sheets.length, 1);
  const sheet = book.sheets[0];
  assert.equal(sheet?.name, "Приборы");
  assert.deepEqual(sheet?.rows[0]?.cells, ["Серийный номер", "Модель", "Дата"]);
  assert.deepEqual(sheet?.rows[1]?.cells, ["BE49081", "DxH-800", "2024-03-25"]);
  assert.equal(sheet?.rows[2]?.cells[2], "2024-03-25T13:30:00");
  assert.deepEqual(sheet?.rows[3]?.cells, [null, null, 42]);
  assert.deepEqual(sheet?.rows.map((row) => row.number), [1, 2, 3, 4]);
});

test("сжатый zip читается так же, как несжатый", async () => {
  const sheets = [{ name: "Лист1", rows: [["Серийный номер"], ["BE49081"]] }] as const;
  const packed = await readXlsxWorkbook(await buildXlsxCompressed(sheets));
  const stored = await readXlsxWorkbook(buildXlsx(sheets));
  assert.deepEqual(packed, stored);
});

test("не книга Excel — понятный отказ, а не падение парсера", async () => {
  await assert.rejects(
    () => readXlsxWorkbook(new TextEncoder().encode("серийный;модель\nBE49081;DxH-800\n")),
    (error: unknown) => error instanceof XlsxReadError && /не файл Excel/u.test(error.message)
  );
  await assert.rejects(() => readXlsxWorkbook(new Uint8Array(0)), XlsxReadError);
  // Архив без книги внутри: это zip, но не .xlsx.
  const foreignZip = zipStore([["hello.txt", new TextEncoder().encode("привет")]]);
  await assert.rejects(
    () => readXlsxWorkbook(foreignZip),
    (error: unknown) => error instanceof XlsxReadError && /не книга Excel/u.test(error.message)
  );
});

test("образец заказчика: 19 строк, две строки заголовков, дата числом и текстом", async (t) => {
  const sample = await customerSampleWorkbook();
  if (!sample) {
    t.skip(`нет образца заказчика: ${CUSTOMER_SAMPLE_PATH.pathname}`);
    return;
  }
  const book = await readXlsxWorkbook(sample);
  assert.equal(book.sheets.length, 1);
  const sheet = book.sheets[0];
  assert.equal(sheet?.name, "Лист1");
  assert.equal(sheet?.rows.length, 19);
  // Первые три строки листа пустые: нумерация начинается с 4, как в Excel.
  assert.equal(sheet?.rows[0]?.number, 4);
  assert.deepEqual(sheet?.rows[0]?.cells, ["наименование прибора", "(s/n прибора)", "вид работ", "описание работ"]);
  assert.deepEqual(sheet?.rows[1]?.cells, ["дата", "Наименование клиента", null, null]);
  assert.deepEqual(sheet?.rows[3]?.cells.slice(0, 2), ["DxH-800 ", "BE49081"]);
  assert.equal(sheet?.rows[4]?.cells[0], "15.03.2023");
  // Единственная дата, записанная числом Excel: 45376.
  const serialDateRow = sheet?.rows.find((row) => row.number === 14);
  assert.equal(serialDateRow?.cells[0], "2024-03-25");
  // Перевод строки внутри описания работ сохраняется.
  assert.match(String(sheet?.rows.find((row) => row.number === 17)?.cells[3]), /\n/u);
});
