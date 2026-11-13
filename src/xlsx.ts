/**
 * Небольшой генератор файлов Excel (.xlsx) без сторонних библиотек.
 * .xlsx это zip-архив с XML-файлами. Пишем архив без сжатия (метод STORE), строки
 * прямо в ячейках (inlineStr), даты настоящими датами Excel, чтобы по ним работали
 * сортировка и фильтры. Excel, LibreOffice, Numbers и Google Таблицы такие файлы открывают.
 */
import { companyClock } from "./task-dates.js";

export type XlsxCell =
  | string
  | number
  | null
  | undefined
  | { readonly date: string; readonly withTime?: boolean }
  | { readonly percent: number }
  | { readonly bold: string };

export interface XlsxSheet {
  /** Имя листа: до 31 символа, без символов : \ / ? * [ ]. */
  readonly name: string;
  readonly rows: readonly (readonly XlsxCell[])[];
  /** Ширина колонок в символах. */
  readonly widths?: readonly number[];
  /** Первая строка таблицы с заголовками: жирная, закреплена, с фильтрами. */
  readonly headerRow?: number;
}

const MAX_CELL_TEXT = 32_767;

export function escapeXml(value: string): string {
  return value
    // Управляющие символы в XML недопустимы (кроме табуляции и переводов строки).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu, "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Номер колонки Excel: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  let current = index + 1;
  while (current > 0) {
    const rest = (current - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

/**
 * Дата Excel: число дней с 30.12.1899. Дата без времени («2026-11-12») так и считается;
 * момент времени (ISO с часами) переводится в местное время того, кто выгружает отчёт.
 */
export function excelDate(value: string, withTime = false): number | undefined {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  let parts: readonly number[];
  if (dateOnly) {
    parts = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0];
  } else {
    // Время в Excel по часам компании, как в акте, а не по поясу устройства.
    const clock = companyClock(value);
    if (!clock) return undefined;
    parts = clock;
  }
  const [year = 0, month = 1, day = 1, hours = 0, minutes = 0, seconds = 0] = parts;
  const days = (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
  return withTime ? days + (hours * 3600 + minutes * 60 + seconds) / 86_400 : days;
}

/** Стили: 0 обычный, 1 жирный, 2 дата, 3 дата и время, 4 процент. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(cell: XlsxCell, reference: string, header: boolean): string {
  if (cell === null || cell === undefined || cell === "") return "";
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? `<c r="${reference}"${header ? " s=\"1\"" : ""}><v>${cell}</v></c>` : "";
  }
  if (typeof cell === "string") {
    const text = escapeXml(cell.slice(0, MAX_CELL_TEXT));
    return `<c r="${reference}" t="inlineStr"${header ? " s=\"1\"" : ""}><is><t xml:space="preserve">${text}</t></is></c>`;
  }
  if ("bold" in cell) {
    return `<c r="${reference}" t="inlineStr" s="1"><is><t xml:space="preserve">${escapeXml(cell.bold.slice(0, MAX_CELL_TEXT))}</t></is></c>`;
  }
  if ("percent" in cell) {
    return Number.isFinite(cell.percent) ? `<c r="${reference}" s="4"><v>${cell.percent}</v></c>` : "";
  }
  const serial = excelDate(cell.date, cell.withTime === true);
  return serial === undefined ? "" : `<c r="${reference}" s="${cell.withTime ? 3 : 2}"><v>${serial}</v></c>`;
}

/** Самая длинная строка листа. Циклом, а не Math.max(...): на сотнях тысяч строк спред переполняет стек. */
function sheetWidth(sheet: XlsxSheet): number {
  let width = 1;
  for (const row of sheet.rows) if (row.length > width) width = row.length;
  return width;
}

function sheetXml(sheet: XlsxSheet): string {
  const header = sheet.headerRow;
  const width = sheetWidth(sheet);
  const rows = sheet.rows.map((row, rowIndex) => {
    const number = rowIndex + 1;
    const cells = row.map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${number}`, header === number)).join("");
    return `<row r="${number}">${cells}</row>`;
  }).join("");
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((value, index) => `<col min="${index + 1}" max="${index + 1}" width="${value}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const frozen = header
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : "<sheetViews><sheetView workbookViewId=\"0\"/></sheetViews>";
  const filter = header && sheet.rows.length > header
    ? `<autoFilter ref="A${header}:${columnName(width - 1)}${sheet.rows.length}"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${frozen}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

function safeSheetName(name: string, index: number, used: Set<string>): string {
  const base = name.replace(/[:\\/?*[\]]/gu, " ").trim().slice(0, 31) || `Лист${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base.slice(0, 28)} ${suffix++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function workbookFiles(sheets: readonly XlsxSheet[]): readonly (readonly [string, string])[] {
  const used = new Set<string>();
  const names = sheets.map((sheet, index) => safeSheetName(sheet.name, index, used));
  const definedNames = sheets
    .map((sheet, index) => {
      const width = sheetWidth(sheet);
      return sheet.headerRow && sheet.rows.length > sheet.headerRow
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">'${escapeXml((names[index] ?? "").replace(/'/gu, "''"))}'!$A$${sheet.headerRow}:$${columnName(width - 1)}$${sheet.rows.length}</definedName>`
        : "";
    })
    .join("");
  return [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ""}</workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)] as const)
  ];
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xFF] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntry {
  readonly name: string;
  /** Исходные данные: по ним считается контрольная сумма. */
  readonly data: Uint8Array;
  /** Данные, сжатые deflate (без заголовков zlib); без них файл кладётся как есть. */
  readonly deflated?: Uint8Array;
}

/** Zip-архив. Время файлов фиксированное: одинаковые данные дают одинаковый файл. */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 01.01.2026 00:00 в формате DOS.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const stored = entry.deflated ?? entry.data;
    const method = entry.deflated ? 8 : 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, stored.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, stored);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014B50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, method, true);
    record.setUint16(12, dosTime, true);
    record.setUint16(14, dosDate, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, stored.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, nameBytes.length, true);
    record.setUint16(30, 0, true);
    record.setUint16(32, 0, true);
    record.setUint16(34, 0, true);
    record.setUint16(36, 0, true);
    record.setUint32(38, 0, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}

/** Zip-архив без сжатия. */
export function zipStore(files: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  return zipFiles(files.map(([name, data]) => ({ name, data })));
}

/** Сжатие deflate средствами браузера; если браузер не умеет, undefined (файл будет без сжатия). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | undefined> {
  if (typeof CompressionStream === "undefined") return undefined;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Файл .xlsx из листов, без сжатия. */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  const encoder = new TextEncoder();
  return zipStore(workbookFiles(sheets).map(([name, content]) => [name, encoder.encode(content)] as const));
}

/** Файл .xlsx со сжатием, как сохраняет сам Excel: в 5–10 раз меньше. */
export async function buildXlsxCompressed(sheets: readonly XlsxSheet[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const files = workbookFiles(sheets).map(([name, content]) => ({ name, data: encoder.encode(content) }));
  const deflated = await Promise.all(files.map((file) => deflateRaw(file.data)));
  return zipFiles(files.map((file, index) => {
    const packed = deflated[index];
    return packed && packed.length < file.data.length ? { ...file, deflated: packed } : file;
  }));
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
