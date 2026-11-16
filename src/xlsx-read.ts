/**
 * Чтение файлов Excel (.xlsx) без сторонних библиотек — пара к записи в xlsx.ts.
 * .xlsx это zip-архив с XML внутри: разбираем каталог архива сами, распаковываем
 * штатным DecompressionStream («deflate-raw»), XML читаем построчным разбором тегов.
 * Работает и в браузере, и в Node 22 — и там и там это встроенные возможности.
 *
 * Книга приходит от человека и доверять ей нельзя: до распаковки проверяем размеры
 * и степень сжатия (zip-бомба), шифрованные и ZIP64-книги не берём совсем.
 */

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const MAX_SHEETS = 64;
const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLUMNS_PER_SHEET = 256;

/** Значение ячейки: текст, число, логическое, дата календарём или пусто. */
export type XlsxCellValue = string | number | boolean | null;

export interface XlsxReadRow {
  /** Номер строки, как его видно в Excel: первая строка листа — 1. */
  readonly number: number;
  /** Значения по индексу столбца: 0 — это A. */
  readonly cells: readonly XlsxCellValue[];
}

export interface XlsxReadSheet {
  readonly name: string;
  readonly rows: readonly XlsxReadRow[];
}

export interface XlsxReadWorkbook {
  readonly sheets: readonly XlsxReadSheet[];
  /** Книга считает даты от 1904 года: числа в ней сдвинуты на 1462 дня. */
  readonly date1904: boolean;
}

export class XlsxReadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "XlsxReadError";
  }
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function endOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new XlsxReadError("Это не файл Excel: в архиве нет каталога ZIP");
}

/** Каталог архива: заодно отсекает шифрованные, ZIP64 и подозрительно сжатые книги. */
function readZipDirectory(source: Uint8Array): readonly ZipEntry[] {
  if (source.byteLength === 0) throw new XlsxReadError("Файл пустой");
  if (source.byteLength > MAX_SOURCE_BYTES) {
    throw new XlsxReadError("Файл больше 32 МБ: разделите выгрузку на части");
  }
  if (source.byteLength < 22) throw new XlsxReadError("Это не файл Excel: файл слишком короткий");
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const end = endOfCentralDirectory(view);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new XlsxReadError("Книги ZIP64 не поддерживаются: пересохраните файл обычным .xlsx");
  }
  if (count === 0 || count > MAX_ARCHIVE_ENTRIES || start + size > end) {
    throw new XlsxReadError("Это не файл Excel: каталог ZIP повреждён");
  }

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder("utf-8");
  let offset = start;
  let totalUncompressed = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new XlsxReadError("Это не файл Excel: запись каталога ZIP повреждена");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if ((flags & 0x1) !== 0) throw new XlsxReadError("Файл защищён паролем: снимите пароль и загрузите снова");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new XlsxReadError("Книги ZIP64 не поддерживаются: пересохраните файл обычным .xlsx");
    }
    totalUncompressed += uncompressedSize;
    const ratio = compressedSize === 0
      ? (uncompressedSize === 0 ? 1 : Number.POSITIVE_INFINITY)
      : uncompressedSize / compressedSize;
    if (uncompressedSize > MAX_ENTRY_BYTES
      || totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES
      || ratio > MAX_COMPRESSION_RATIO) {
      throw new XlsxReadError("Файл отклонён: внутри архива подозрительно большие данные");
    }
    const nameBytes = source.subarray(offset + 46, offset + 46 + nameLength);
    entries.push({
      name: decoder.decode(nameBytes),
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  try {
    const stream = new Blob([data as unknown as BlobPart]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // Распаковщик браузера бросает TypeError с пустым текстом: человеку он ничего не скажет.
    throw new XlsxReadError("Файл повреждён: часть книги не распаковывается. Пересохраните его в Excel");
  }
}

async function entryText(source: Uint8Array, entry: ZipEntry): Promise<string> {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (entry.localOffset + 30 > source.byteLength
    || view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    throw new XlsxReadError("Это не файл Excel: запись архива повреждена");
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > source.byteLength) throw new XlsxReadError("Это не файл Excel: запись архива обрезана");
  const packed = source.subarray(start, end);
  if (entry.method === 0) return new TextDecoder("utf-8").decode(packed);
  if (entry.method !== 8) throw new XlsxReadError("Внутри архива неизвестный способ сжатия");
  const unpacked = await inflateRaw(packed);
  if (unpacked.byteLength > MAX_ENTRY_BYTES) {
    throw new XlsxReadError("Файл отклонён: внутри архива подозрительно большие данные");
  }
  return new TextDecoder("utf-8").decode(unpacked);
}

export function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/giu, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const point = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

function attributes(source: string): Readonly<Record<string, string>> {
  const found: Record<string, string> = Object.create(null) as Record<string, string>;
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/gu;
  let match = pattern.exec(source);
  while (match) {
    if (match[1] && match[2] !== undefined) found[match[1]] = unescapeXml(match[2]);
    match = pattern.exec(source);
  }
  return found;
}

/** Текст элемента <si> или <is>: куски <t> склеиваются, ruby-подписи <rPh> пропускаем. */
function sharedText(source: string): string {
  const withoutRuby = source.replace(/<rPh[\s\S]*?<\/rPh>/gu, "");
  const parts: string[] = [];
  const pattern = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/gu;
  let match = pattern.exec(withoutRuby);
  while (match) {
    parts.push(unescapeXml(match[1] ?? ""));
    match = pattern.exec(withoutRuby);
  }
  return parts.join("");
}

function sharedStrings(xml: string): readonly string[] {
  const values: string[] = [];
  const pattern = /<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/gu;
  let match = pattern.exec(xml);
  while (match) {
    values.push(sharedText(match[1] ?? ""));
    match = pattern.exec(xml);
  }
  return values;
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58
]);

/** Дата ли это по формату ячейки: без формата число 45376 от показания счётчика не отличить. */
export function isDateFormatCode(code: string): boolean {
  const meaningful = code
    .replace(/"[^"]*"/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\\./gu, "");
  return /[ymdhs]/iu.test(meaningful);
}

interface StyleDates {
  /** true, если стиль с таким номером показывает число датой или временем. */
  readonly isDate: (styleIndex: number | undefined) => boolean;
}

function styleDates(xml: string | undefined): StyleDates {
  if (!xml) return { isDate: () => false };
  const custom = new Map<number, boolean>();
  const formats = /<numFmt\s[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"[^>]*?\/>/gu;
  let format = formats.exec(xml);
  while (format) {
    custom.set(Number(format[1]), isDateFormatCode(unescapeXml(format[2] ?? "")));
    format = formats.exec(xml);
  }
  const cellXfs = /<cellXfs(?:\s[^>]*)?>([\s\S]*?)<\/cellXfs>/u.exec(xml);
  const dateByStyle: boolean[] = [];
  if (cellXfs?.[1]) {
    const xfs = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/gu;
    let xf = xfs.exec(cellXfs[1]);
    while (xf) {
      const id = Number(attributes(xf[1] ?? "").numFmtId ?? "0");
      dateByStyle.push(custom.get(id) ?? BUILTIN_DATE_FORMATS.has(id));
      xf = xfs.exec(cellXfs[1]);
    }
  }
  return { isDate: (styleIndex) => styleIndex === undefined ? false : dateByStyle[styleIndex] === true };
}

/** Номер столбца по ссылке ячейки: A1 → 0, B7 → 1, AA3 → 26. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/u.exec(reference.toUpperCase());
  if (!letters?.[1]) return -1;
  let index = 0;
  for (const letter of letters[1]) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const MILLISECONDS_PER_DAY = 86_400_000;
/** 1 марта 1900 года: до него нумерация Excel сбита «лишним» 29 февраля 1900-го. */
const MIN_EXCEL_SERIAL = 61;
const MAX_EXCEL_SERIAL = 2_958_465;

/**
 * Число Excel в календарную дату: «45376» → «2024-03-25». Дробная часть — время.
 * Отсчёт от 30.12.1899 (книги 1904 года сдвинуты на 1462 дня).
 */
export function excelSerialToDateText(serial: number, date1904 = false): string | undefined {
  const shifted = date1904 ? serial + 1462 : serial;
  if (!Number.isFinite(shifted) || shifted < MIN_EXCEL_SERIAL || shifted > MAX_EXCEL_SERIAL) return undefined;
  const whole = Math.floor(shifted);
  const dayMilliseconds = Math.round((shifted - whole) * MILLISECONDS_PER_DAY);
  const moment = new Date(Date.UTC(1899, 11, 30) + whole * MILLISECONDS_PER_DAY + dayMilliseconds);
  if (Number.isNaN(moment.getTime())) return undefined;
  const date = moment.toISOString().slice(0, 10);
  if (dayMilliseconds === 0) return date;
  return `${date}T${moment.toISOString().slice(11, 19)}`;
}

function cellValue(
  raw: string,
  attrs: Readonly<Record<string, string>>,
  strings: readonly string[],
  styles: StyleDates,
  date1904: boolean
): XlsxCellValue {
  const type = attrs.t ?? "n";
  if (type === "s") {
    const index = Number(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u.exec(raw)?.[1] ?? "");
    return Number.isInteger(index) ? (strings[index] ?? null) : null;
  }
  if (type === "inlineStr") {
    const inline = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/u.exec(raw)?.[1];
    return inline === undefined ? null : sharedText(inline) || null;
  }
  const value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/u.exec(raw)?.[1];
  if (value === undefined) return null;
  const text = unescapeXml(value);
  if (type === "str") return text.trim() === "" ? null : text;
  if (type === "e") return null;
  if (type === "b") return text === "1";
  if (type === "d") return text.trim() === "" ? null : text.trim();
  if (text.trim() === "") return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  const styleIndex = attrs.s === undefined ? undefined : Number(attrs.s);
  if (styles.isDate(Number.isInteger(styleIndex) ? styleIndex : undefined)) {
    return excelSerialToDateText(number, date1904) ?? number;
  }
  return number;
}

function readSheet(
  name: string,
  xml: string,
  strings: readonly string[],
  styles: StyleDates,
  date1904: boolean
): XlsxReadSheet {
  const rows: XlsxReadRow[] = [];
  const rowPattern = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu;
  let rowMatch = rowPattern.exec(xml);
  let fallbackNumber = 0;
  while (rowMatch) {
    fallbackNumber += 1;
    const rowAttributes = attributes(rowMatch[1] ?? "");
    const number = Number(rowAttributes.r ?? fallbackNumber);
    const cells: XlsxCellValue[] = [];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu;
    let cellMatch = cellPattern.exec(rowMatch[2] ?? "");
    let fallbackColumn = -1;
    while (cellMatch) {
      const cellAttributes = attributes(cellMatch[1] ?? "");
      fallbackColumn += 1;
      const index = cellAttributes.r ? columnIndex(cellAttributes.r) : fallbackColumn;
      // Клетки за пределом листа пропускаем: Excel размечает пустыми клетками
      // всю строку, когда её форматируют целиком, и ронять на этом файл нельзя.
      if (index >= 0 && index < MAX_COLUMNS_PER_SHEET) {
        fallbackColumn = index;
        while (cells.length < index) cells.push(null);
        cells[index] = cellValue(cellMatch[2] ?? "", cellAttributes, strings, styles, date1904);
      }
      cellMatch = cellPattern.exec(rowMatch[2] ?? "");
    }
    if (rows.length >= MAX_ROWS_PER_SHEET) {
      throw new XlsxReadError("В листе слишком много строк: оставьте не больше 100 000");
    }
    rows.push({ number: Number.isInteger(number) && number > 0 ? number : fallbackNumber, cells });
    rowMatch = rowPattern.exec(xml);
  }
  return { name, rows };
}

function sheetOrder(workbookXml: string, relsXml: string | undefined): readonly { readonly name: string; readonly path: string }[] {
  const targets = new Map<string, string>();
  if (relsXml) {
    const pattern = /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/gu;
    let match = pattern.exec(relsXml);
    while (match) {
      const attrs = attributes(match[1] ?? "");
      if (attrs.Id && attrs.Target) targets.set(attrs.Id, attrs.Target);
      match = pattern.exec(relsXml);
    }
  }
  const sheets: { name: string; path: string }[] = [];
  const pattern = /<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/gu;
  let match = pattern.exec(workbookXml);
  let index = 0;
  while (match) {
    index += 1;
    const attrs = attributes(match[1] ?? "");
    const relation = attrs["r:id"] ?? attrs.id;
    const target = relation ? targets.get(relation) : undefined;
    const path = target
      ? (target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//u, "")}`)
      : `xl/worksheets/sheet${index}.xml`;
    sheets.push({ name: attrs.name ?? `Лист${index}`, path });
    match = pattern.exec(workbookXml);
  }
  return sheets;
}

/** Читает книгу Excel: листы в их порядке, значения по столбцам, даты календарём. */
export async function readXlsxWorkbook(source: Uint8Array): Promise<XlsxReadWorkbook> {
  const entries = readZipDirectory(source);
  // Регистр имён внутри архива у разных программ разный: ищем без учёта регистра.
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const workbookEntry = byName.get("xl/workbook.xml");
  if (!workbookEntry) {
    throw new XlsxReadError("Это не книга Excel: внутри нет xl/workbook.xml. Сохраните файл как .xlsx");
  }
  const workbookXml = await entryText(source, workbookEntry);
  const relsEntry = byName.get("xl/_rels/workbook.xml.rels");
  const stringsEntry = byName.get("xl/sharedstrings.xml");
  const stylesEntry = byName.get("xl/styles.xml");
  const relsXml = relsEntry ? await entryText(source, relsEntry) : undefined;
  const strings = stringsEntry ? sharedStrings(await entryText(source, stringsEntry)) : [];
  const styles = styleDates(stylesEntry ? await entryText(source, stylesEntry) : undefined);
  const date1904 = /date1904="(1|true)"/u.test(workbookXml);

  const order = sheetOrder(workbookXml, relsXml);
  if (order.length === 0) throw new XlsxReadError("В книге нет ни одного листа");
  if (order.length > MAX_SHEETS) throw new XlsxReadError("В книге слишком много листов: оставьте не больше 64");
  const sheets: XlsxReadSheet[] = [];
  for (const sheet of order) {
    const entry = byName.get(sheet.path.toLowerCase());
    if (!entry) continue;
    sheets.push(readSheet(sheet.name, await entryText(source, entry), strings, styles, date1904));
  }
  if (sheets.length === 0) throw new XlsxReadError("В книге нет ни одного читаемого листа");
  return { sheets, date1904 };
}
