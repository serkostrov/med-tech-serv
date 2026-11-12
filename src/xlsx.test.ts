import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32 as nodeCrc32, inflateRawSync } from "node:zlib";
import { buildXlsx, buildXlsxCompressed, columnName, crc32, escapeXml, excelDate } from "./xlsx.js";
import { reportWorkbook, reportWorkbookSheets } from "./report-export.js";
import { allPages, type OperationsReportRecord, type ReportTaskRow } from "./m2-api.js";

/** Читает zip без сжатия, как его пишет генератор: имя файла → содержимое. */
function unzip(data: Uint8Array): Map<string, string> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const files = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034B50) {
    const method = view.getUint16(offset + 8, true);
    assert.ok(method === 0 || method === 8, "без сжатия или deflate");
    const crc = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const plainSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extra = view.getUint16(offset + 28, true);
    const name = decoder.decode(data.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extra;
    const stored = data.subarray(start, start + size);
    const body = method === 8 ? new Uint8Array(inflateRawSync(stored)) : stored;
    assert.equal(body.length, plainSize, `размер ${name}`);
    assert.equal(crc, nodeCrc32(body), `контрольная сумма ${name}`);
    files.set(name, decoder.decode(body));
    offset = start + size;
  }
  // Дальше центральный каталог и конец архива.
  assert.equal(view.getUint32(offset, true), 0x02014B50, "центральный каталог");
  const end = data.length - 22;
  assert.equal(view.getUint16(offset + 10, true) === 0 || view.getUint16(offset + 10, true) === 8, true);
  assert.equal(view.getUint32(end, true), 0x06054B50, "конец архива");
  assert.equal(view.getUint16(end + 10, true), files.size, "число файлов в каталоге");
  assert.equal(view.getUint32(end + 16, true), offset, "смещение каталога");
  return files;
}

describe("Excel file", () => {
  it("writes a valid zip with the parts Excel needs", () => {
    const files = unzip(buildXlsx([{ name: "Лист", rows: [["Текст", 5]] }]));
    assert.deepEqual([...files.keys()], ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    assert.match(files.get("xl/workbook.xml") ?? "", /<sheet name="Лист" sheetId="1" r:id="rId1"\/>/u);
    assert.match(files.get("xl/worksheets/sheet1.xml") ?? "", /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Текст<\/t><\/is><\/c><c r="B1"><v>5<\/v><\/c>/u);
  });

  it("computes the same checksum as zlib", () => {
    const sample = new TextEncoder().encode("МедТехСервис, отчёт 12.11.2026");
    assert.equal(crc32(sample), nodeCrc32(sample));
    assert.equal(crc32(new Uint8Array()), 0);
  });

  it("escapes text and drops characters XML does not allow", () => {
    assert.equal(escapeXml("A & B <c> \"d\"\u0001"), "A &amp; B &lt;c&gt; &quot;d&quot;");
    const sheet = unzip(buildXlsx([{ name: "x", rows: [["<script>&"]] }])).get("xl/worksheets/sheet1.xml") ?? "";
    assert.match(sheet, /&lt;script&gt;&amp;/u);
  });

  it("names columns and converts dates like Excel", () => {
    assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
    assert.equal(excelDate("1900-03-01"), 61);
    assert.equal(excelDate("2026-11-12"), 46338);
    assert.equal(excelDate("не дата"), undefined);
    const moment = new Date(2026, 10, 12, 18, 0, 0);
    assert.equal(excelDate(moment.toISOString(), true), 46338.75);
  });

  it("freezes and filters the header row of the tasks sheet", () => {
    const files = unzip(buildXlsx([{ name: "Заявки", headerRow: 1, rows: [["Номер", "Срок"], ["З-1", { date: "2026-11-12" }]] }]));
    const sheet = files.get("xl/worksheets/sheet1.xml") ?? "";
    assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/u);
    assert.match(sheet, /<autoFilter ref="A1:B2"\/>/u);
    assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/u);
    assert.match(sheet, /<c r="B2" s="2"><v>46338<\/v><\/c>/u);
    assert.match(files.get("xl/workbook.xml") ?? "", /<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Заявки'!\$A\$1:\$B\$2<\/definedName>/u);
  });
});

describe("report export", () => {
  const report: OperationsReportRecord = {
    period: { from: "2026-11-01", to: "2026-11-12" },
    metrics: { taskCount: 3, closedCount: 1, closedOnTimePercent: 100, overdueCount: 1, activeEngineerCount: 0, belowMinimumCount: 0 },
    tasksByStatus: [{ code: "in_progress", name: "В работе", value: 2 }, { code: "closed", name: "Закрыта", value: 1 }],
    tasksByWorkType: [{ code: "repair", name: "Ремонт", value: 3 }],
    tasksByMonth: [{ key: "2026-11", name: "ноя 2026", value: 3 }]
  };
  const tasks: ReportTaskRow[] = [
    { number: "З-1", createdAt: "2026-11-02T07:00:00.000Z", title: "Не включается", status: "closed", statusName: "Закрыта", priority: "urgent", workTypeName: "Ремонт", siteName: "ГКБ № 1", equipment: "Beckman AU 480", serialNumber: "SN-1", engineerName: "Иванов П. А.", periodFrom: "2026-11-02", periodTo: "2026-11-05", completedAt: "2026-11-04T10:00:00.000Z" },
    { number: "З-2", createdAt: "2026-11-03T07:00:00.000Z", title: "Шум", status: "in_progress", statusName: "В работе", priority: "planned", periodTo: "2026-11-08" },
    { number: "З-3", createdAt: "2026-11-10T07:00:00.000Z", title: "ТО", status: "in_progress", statusName: "В работе", priority: "planned", periodTo: "2026-11-30" }
  ];

  it("puts the summary and every task of the period into two sheets", () => {
    const [summary, list] = reportWorkbookSheets(report, tasks, "2026-11-12");
    assert.equal(summary?.name, "Сводка");
    assert.deepEqual(summary?.rows[4], ["Всего заявок", 3]);
    assert.deepEqual(summary?.rows[6], ["Закрыто вовремя", { percent: 1 }]);
    assert.deepEqual(summary?.rows[8], ["Открытые", 2]);
    assert.equal(list?.name, "Заявки");
    assert.equal(list?.rows.length, 4);
    assert.equal(list?.headerRow, 1);
    const [first, second, third] = list?.rows.slice(1) ?? [];
    assert.equal(first?.[4], "Срочная");
    assert.equal(first?.[13], "Да");
    assert.equal(second?.[14], "Да", "срок вышел, задача открыта");
    assert.equal(third?.[14], "", "срок ещё не вышел");
  });
});


describe("large reports", () => {
  it("reads every page, four at a time, in order", async () => {
    const all = Array.from({ length: 23 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const calls: number[] = [];
    const rows = await allPages(async (from, to, withCount) => {
      calls.push(from);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { data: all.slice(from, to + 1), error: null, count: withCount ? all.length : null };
    }, "ошибка", 3);
    assert.deepEqual(rows, all);
    assert.ok(peak <= 4, `одновременно не больше 4 запросов, было ${peak}`);
    assert.equal(calls.length, 8);
  });

  it("keeps reading when rows were added while reading, and without a total", async () => {
    const all = Array.from({ length: 7 }, (_, index) => index);
    const rows = await allPages(async (from, to) => ({ data: all.slice(from, to + 1), error: null, count: null }), "ошибка", 3);
    assert.deepEqual(rows, all);
    await assert.rejects(allPages(async () => ({ data: null, error: { message: "boom" }, count: null }), "Не получилось выгрузить"), /Не получилось выгрузить/u);
  });

  it("builds a compressed file for 20 000 tasks quickly", async () => {
    const report: OperationsReportRecord = {
      period: { from: "2026-01-01", to: "2026-12-31" },
      metrics: { taskCount: 20_000, closedCount: 10_000, closedOnTimePercent: 80, overdueCount: 500, activeEngineerCount: 0, belowMinimumCount: 0 },
      tasksByStatus: [{ code: "closed", name: "Закрыта", value: 10_000 }, { code: "in_progress", name: "В работе", value: 10_000 }],
      tasksByWorkType: [{ code: "repair", name: "Ремонт", value: 20_000 }],
      tasksByMonth: [{ key: "2026-01", name: "янв 2026", value: 20_000 }]
    };
    const tasks: ReportTaskRow[] = Array.from({ length: 20_000 }, (_, index) => ({
      number: `З-${String(index + 1).padStart(6, "0")}`,
      createdAt: "2026-03-05T07:30:00.000Z",
      title: `Не включается анализатор после скачка напряжения, заявка ${index + 1}`,
      status: index % 2 ? "closed" : "in_progress",
      statusName: index % 2 ? "Закрыта" : "В работе",
      priority: index % 3 ? "planned" : "urgent",
      workTypeName: "Ремонт",
      siteName: "ГКБ № 1 им. Н. И. Пирогова, КДЛ",
      equipment: "Beckman Coulter AU 480",
      serialNumber: `SN-${index}`,
      engineerName: "Иванов Пётр Алексеевич",
      periodFrom: "2026-03-05",
      periodTo: "2026-03-07",
      ...(index % 2 ? { completedAt: "2026-03-06T10:00:00.000Z" } : {})
    }));
    const started = performance.now();
    const file = await reportWorkbook(report, tasks);
    const seconds = (performance.now() - started) / 1000;
    const plain = buildXlsx(reportWorkbookSheets(report, tasks));
    assert.ok(seconds < 10, `файл собран за ${seconds.toFixed(1)} с`);
    assert.ok(file.length * 4 < plain.length, `сжатый ${file.length} байт, без сжатия ${plain.length}`);
    const sheet = unzip(file).get("xl/worksheets/sheet2.xml") ?? "";
    assert.match(sheet, /<row r="20001">/u);
    assert.match(sheet, /<autoFilter ref="A1:O20001"\/>/u);
  });

  it("compresses small files too and keeps them readable", async () => {
    const files = unzip(await buildXlsxCompressed([{ name: "Сводка", rows: [["Всего заявок", 3]] }]));
    assert.match(files.get("xl/worksheets/sheet1.xml") ?? "", /Всего заявок/u);
  });
});
