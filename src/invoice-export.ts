/**
 * Выгрузка счёта файлом Excel — тем же способом, что и отчёт по заявкам (`report-export.ts`):
 * свой генератор .xlsx, без сторонних библиотек. Строки и названия столбцов даёт база
 * (`invoiceExportRows`), здесь мы их только раскладываем по листу, чтобы файл можно было
 * отдать в 1С одной таблицей: одна строка счёта — одна строка файла.
 */
import { buildXlsxCompressed, type XlsxCell, type XlsxSheet } from "./xlsx.js";

export type InvoiceExportRow = Readonly<Record<string, string | number>>;

/** Столбцы в порядке первой строки; то, что встретилось только дальше, добавляем в конец. */
export function invoiceExportColumns(rows: readonly InvoiceExportRow[]): readonly string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/** Дата из базы («2026-11-05» или ISO с часами) попадает в файл настоящей датой: по ней работают сортировка и фильтры. */
function cell(value: string | number | undefined): XlsxCell {
  if (typeof value === "number") return value;
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return { date: value };
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u.test(value)) return { date: value, withTime: true };
  return value;
}

/** Ширина колонки по самому длинному значению, но в разумных пределах. */
function width(column: string, rows: readonly InvoiceExportRow[]): number {
  const longest = rows.reduce((max, row) => Math.max(max, String(row[column] ?? "").length), column.length);
  return Math.min(44, Math.max(12, longest + 2));
}

/** Лист счёта: шапка из названий столбцов базы и строки под ней. */
export function invoiceSheets(rows: readonly InvoiceExportRow[]): readonly XlsxSheet[] {
  const columns = invoiceExportColumns(rows);
  if (columns.length === 0) return [{ name: "Счёт", rows: [["В счёте нет позиций"]], widths: [30] }];
  return [{
    name: "Счёт",
    // Шапку жирной и закреплённой делает сам генератор по headerRow.
    rows: [columns, ...rows.map((row) => columns.map((column) => cell(row[column])))],
    headerRow: 1,
    widths: columns.map((column) => width(column, rows))
  }];
}

export function invoiceWorkbook(rows: readonly InvoiceExportRow[]): Promise<Uint8Array> {
  return buildXlsxCompressed(invoiceSheets(rows));
}
