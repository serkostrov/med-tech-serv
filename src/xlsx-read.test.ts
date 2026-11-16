import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { buildXlsx, zipStore } from "./xlsx.js";
import { columnIndex, parseCsvRows, parseSharedStrings, parseSheet, readSpreadsheetFile, readXlsxRows, unzipEntries } from "./xlsx-read.js";

const encoder = new TextEncoder();

/** Книга Excel с общей таблицей строк: так пишет настоящий Excel, а не наш генератор. */
function excelLikeWorkbook(): Uint8Array {
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
<si><t>Артикул</t></si><si><t>Кол-во</t></si><si><t>AU-LAMP-12V20W</t></si>
<si><r><t>XN-</t></r><r><t>FILTER-WB</t></r></si><si><t xml:space="preserve">Состояние</t></si></sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>4</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5</v></c><c r="C2" t="inlineStr"><is><t>Н</t></is></c></row>
<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="e"><v>#N/A</v></c></row>
</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Накладная" sheetId="1" r:id="rId7"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/sheetMain.xml"/></Relationships>`;
  return zipStore([
    ["xl/workbook.xml", encoder.encode(workbook)],
    ["xl/_rels/workbook.xml.rels", encoder.encode(rels)],
    ["xl/sharedStrings.xml", encoder.encode(shared)],
    ["xl/worksheets/sheetMain.xml", encoder.encode(sheet)]
  ]);
}

describe("чтение таблиц: xlsx и csv", () => {
  it("читает то, что сам же собрал: строки, числа и пустые клетки на местах", async () => {
    const data = buildXlsx([{
      name: "Приход",
      headerRow: 1,
      rows: [
        ["Артикул", "Наименование", "Кол-во"],
        ["AU-LAMP-12V20W", "Лампа", 4],
        ["XN-FILTER-WB", "", 10]
      ]
    }]);
    assert.deepEqual(await readXlsxRows(data), [
      ["Артикул", "Наименование", "Кол-во"],
      ["AU-LAMP-12V20W", "Лампа", "4"],
      // Пустая клетка остаётся пустой: иначе количество съехало бы в колонку наименования.
      ["XN-FILTER-WB", "", "10"]
    ]);
  });

  it("читает книгу Excel: общая таблица строк, куски с разным шрифтом, лист не в sheet1.xml", async () => {
    assert.deepEqual(await readXlsxRows(excelLikeWorkbook()), [
      ["Артикул", "Кол-во", "Состояние"],
      ["AU-LAMP-12V20W", "5", "Н"],
      // Ошибка формулы читается пустой клеткой, а не кодом ошибки в артикуле.
      ["XN-FILTER-WB", "", ""]
    ]);
  });

  it("распаковывает сжатые файлы архива, а не только сложенные как есть", async () => {
    const plain = encoder.encode("<sst><si><t>Сжатая строка</t></si></sst>");
    const packed = new Uint8Array(deflateRawSync(plain));
    // Собираем архив со сжатым файлом вручную: генератор проекта пишет deflate только в браузере.
    const entries = await unzipEntries(zipFilesWithDeflate("xl/sharedStrings.xml", plain, packed));
    assert.deepEqual(parseSharedStrings(new TextDecoder().decode(entries.get("xl/sharedStrings.xml"))), ["Сжатая строка"]);
  });

  it("номер колонки по имени клетки, как в обратную сторону", () => {
    assert.equal(columnIndex("A1"), 0);
    assert.equal(columnIndex("B12"), 1);
    assert.equal(columnIndex("AA3"), 26);
    assert.equal(columnIndex("ZZ9"), 701);
  });

  it("клетки без номера идут подряд, а по номеру встают на своё место", () => {
    const xml = "<row r=\"1\"><c t=\"inlineStr\"><is><t>первая</t></is></c><c r=\"D1\" t=\"inlineStr\"><is><t>четвёртая</t></is></c></row>";
    assert.deepEqual(parseSheet(xml, []), [["первая", "", "", "четвёртая"]]);
  });

  it("разбирает csv с точкой с запятой, запятой и табуляцией", () => {
    assert.deepEqual(parseCsvRows("Артикул;Кол-во\nAU-1;5"), [["Артикул", "Кол-во"], ["AU-1", "5"]]);
    assert.deepEqual(parseCsvRows("article,qty\nAU-1,5"), [["article", "qty"], ["AU-1", "5"]]);
    assert.deepEqual(parseCsvRows("article\tqty\nAU-1\t5"), [["article", "qty"], ["AU-1", "5"]]);
  });

  it("в кавычках разделитель, перевод строки и сами кавычки — обычные знаки", () => {
    assert.deepEqual(parseCsvRows("﻿Артикул;Наименование\n\"AU-1\";\"Лампа 12 В; 20 Вт\"\n\"XN-2\";\"Фильтр \"\"цельной крови\"\"\""), [
      ["Артикул", "Наименование"],
      ["AU-1", "Лампа 12 В; 20 Вт"],
      ["XN-2", "Фильтр \"цельной крови\""]
    ]);
  });

  it("файл .xls старого формата и не-архив объясняются по-русски", async () => {
    await assert.rejects(
      () => readSpreadsheetFile({ name: "накладная.xls", arrayBuffer: async () => encoder.encode("ÐÏ\u0011à").buffer as ArrayBuffer }),
      /сохраните его как \.xlsx или \.csv/u
    );
    await assert.rejects(() => readXlsxRows(encoder.encode("не архив")), /не похож на xlsx/u);
  });

  it("битый архив объясняется по-русски, а не ошибкой распаковщика", async () => {
    // Оглавление указывает за край файла (так же выглядит zip64 с 0xFFFFFFFF).
    const broken = zipStore([["xl/sharedStrings.xml", encoder.encode("<sst/>")]]);
    const view = new DataView(broken.buffer, broken.byteOffset, broken.byteLength);
    const centralOffset = view.getUint32(broken.length - 6, true);
    view.setUint32(centralOffset + 42, 0xFFFFFFFF, true);
    await assert.rejects(() => unzipEntries(broken), /повреждён.*за его край/u);
    // Файл архива обрезан: данные короче, чем обещает оглавление.
    const cut = zipStore([["xl/sharedStrings.xml", encoder.encode("<sst/>")]]);
    const cutView = new DataView(cut.buffer, cut.byteOffset, cut.byteLength);
    cutView.setUint32(cutView.getUint32(cut.length - 6, true) + 20, 10_000, true);
    await assert.rejects(() => unzipEntries(cut), /повреждён.*обрезана/u);
  });

  it("csv из Excel в русской кодировке читается буквами, а не кракозябрами", async () => {
    // windows-1251: так Excel в русской локали сохраняет CSV по умолчанию.
    const cp1251 = Uint8Array.from([
      0xC0, 0xF0, 0xF2, 0xE8, 0xEA, 0xF3, 0xEB, 0x3B, 0xCA, 0xEE, 0xEB, 0x2D, 0xE2, 0xEE, 0x3B, 0xD1, 0xEE, 0xF1, 0xF2, 0x2E,
      0x0A, 0x41, 0x55, 0x2D, 0x31, 0x3B, 0x34, 0x3B, 0xCD
    ]);
    const rows = await readSpreadsheetFile({ name: "накладная.csv", arrayBuffer: async () => cp1251.buffer as ArrayBuffer });
    assert.deepEqual(rows, [["Артикул", "Кол-во", "Сост."], ["AU-1", "4", "Н"]]);
  });

  it("клетка за последней колонкой Excel не съедает память", () => {
    // ZZZZZ1 это 12 млн колонок: наивный добор пустых клеток повесил бы страницу.
    const xml = "<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>есть</t></is></c>"
      + "<c r=\"ZZZZZ1\" t=\"inlineStr\"><is><t>мусор</t></is></c></row>";
    const started = Date.now();
    assert.deepEqual(parseSheet(xml, []), [["есть"]]);
    assert.ok(Date.now() - started < 1000, "разбор не должен занимать секунды");
  });

  it("файл без расширения читается как csv: накладную часто сохраняют текстом", async () => {
    const rows = await readSpreadsheetFile({
      name: "накладная.csv",
      arrayBuffer: async () => encoder.encode("Артикул;Кол-во\nAU-1;3").buffer as ArrayBuffer
    });
    assert.deepEqual(rows, [["Артикул", "Кол-во"], ["AU-1", "3"]]);
  });
});

/** Zip с одним сжатым файлом: локальный заголовок, центральный каталог и конец архива. */
function zipFilesWithDeflate(name: string, plain: Uint8Array, packed: Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034B50, true);
  local.setUint16(8, 8, true);
  local.setUint32(18, packed.length, true);
  local.setUint32(22, plain.length, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014B50, true);
  central.setUint16(10, 8, true);
  central.setUint32(20, packed.length, true);
  central.setUint32(24, plain.length, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint32(42, 0, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  const centralOffset = 30 + nameBytes.length + packed.length;
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, centralOffset, true);
  const parts = [
    new Uint8Array(local.buffer), nameBytes, packed,
    new Uint8Array(central.buffer), nameBytes, new Uint8Array(end.buffer)
  ];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}
